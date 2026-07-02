package com.wordhunter.pocket

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.documentfile.provider.DocumentFile
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.concurrent.Executors

class MainActivity : TauriActivity() {
  private var appWebView: WebView? = null
  private var textToSpeech: TextToSpeech? = null
  private val syncExecutor = Executors.newSingleThreadExecutor()
  private val pdfRenderSessions = mutableMapOf<String, PdfRenderSession>()
  private val pdfRenderLock = Any()
  @Volatile private var ttsReady = false
  @Volatile private var pendingSyncToken: String? = null
  private var pendingSyncResult: JSONObject? = null
  private val knownDataNames = setOf("records", "books", "argos-packages")
  private val skippedBookRecordNames = setOf("book.json", "book.bak", "metadata.json", "text.txt")
  private val syncFolderLauncher = registerForActivityResult(
    ActivityResultContracts.StartActivityForResult()
  ) { result ->
    val syncToken = pendingSyncToken
    pendingSyncToken = null
    val uri = result.data?.data
    if (result.resultCode != Activity.RESULT_OK) {
      dispatchAndroidSyncResult(success = false, path = null, error = null, cancelled = true)
      return@registerForActivityResult
    }
    if (uri == null) {
      dispatchAndroidSyncResult(success = false, path = null, error = null, cancelled = true)
      return@registerForActivityResult
    }

    syncExecutor.execute {
      runCatching { syncSelectedFolder(uri, token = syncToken) }
        .onSuccess { path ->
          dispatchAndroidSyncResult(success = true, path = path, error = null, cancelled = false)
        }
        .onFailure { error ->
          dispatchAndroidSyncResult(success = false, path = null, error = error.message, cancelled = false)
        }
      }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    textToSpeech = TextToSpeech(this) { status ->
      ttsReady = status == TextToSpeech.SUCCESS
    }
    textToSpeech?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
      override fun onStart(utteranceId: String?) {}

      override fun onDone(utteranceId: String?) {
        dispatchAndroidTtsResult(utteranceId, "done")
      }

      @Deprecated("Deprecated in Android API")
      override fun onError(utteranceId: String?) {
        dispatchAndroidTtsResult(utteranceId, "error")
      }

      override fun onStop(utteranceId: String?, interrupted: Boolean) {
        dispatchAndroidTtsResult(utteranceId, "stopped")
      }

      override fun onRangeStart(utteranceId: String?, start: Int, end: Int, frame: Int) {
        dispatchAndroidTtsResult(utteranceId, "range", start, end)
      }
    })
  }

  override fun onResume() {
    super.onResume()
    dispatchPendingAndroidSyncResult()
  }

  override fun onWebViewCreate(webView: WebView) {
    appWebView = webView
    webView.clearCache(true)
    webView.addJavascriptInterface(AndroidSyncBridge(), "WordHunterAndroid")
    Log.i("WordHunter", "WebView created; parent=${webView.parent != null}")
    if (webView.parent == null) {
      setContentView(webView)
    }
  }

  override fun onDestroy() {
    syncExecutor.shutdownNow()
    closeAllPdfRenderSessions()
    textToSpeech?.stop()
    textToSpeech?.shutdown()
    textToSpeech = null
    super.onDestroy()
  }

  inner class AndroidSyncBridge {
    @JavascriptInterface
    fun chooseSyncFolder(token: String?) {
      pendingSyncToken = token
      runOnUiThread {
        syncFolderLauncher.launch(syncFolderPickerIntent())
      }
    }

    @JavascriptInterface
    fun forceSyncFolder(token: String?): Boolean {
      val uri = savedSyncFolderUri() ?: return false
      syncExecutor.execute {
        runCatching { syncSelectedFolder(uri, persistPermission = false, token = token) }
          .onSuccess { path ->
            dispatchAndroidSyncResult(success = true, path = path, error = null, cancelled = false)
          }
          .onFailure { error ->
            dispatchAndroidSyncResult(success = false, path = null, error = error.message, cancelled = false)
          }
      }
      return true
    }

    @JavascriptInterface
    fun getSyncFolderLabel(): String? {
      val prefs = getSharedPreferences("wordhunter-sync", MODE_PRIVATE)
      return prefs.getString("sync_label", null) ?: prefs.getString("sync_uri", null)
    }

    @JavascriptInterface
    fun speak(text: String?, lang: String?, rate: Double, utteranceId: String?): Boolean {
      val engine = textToSpeech ?: return false
      val phrase = text?.trim()?.takeIf { it.isNotEmpty() } ?: return false
      if (!ttsReady) return false
      val result = engine.setLanguage(localeFor(lang ?: "en"))
      if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
        return false
      }
      engine.setSpeechRate(rate.toFloat().coerceIn(0.5f, 2.0f))
      return engine.speak(
        phrase,
        TextToSpeech.QUEUE_FLUSH,
        Bundle.EMPTY,
        utteranceId ?: System.nanoTime().toString()
      ) == TextToSpeech.SUCCESS
    }

    @JavascriptInterface
    fun stopTts() {
      runOnUiThread {
        textToSpeech?.stop()
      }
    }

    @JavascriptInterface
    fun openUrl(url: String?): Boolean {
      val target = url?.trim()?.takeIf { it.isNotEmpty() } ?: return false
      val uri = runCatching { Uri.parse(target) }.getOrNull() ?: return false
      val scheme = uri.scheme?.lowercase(Locale.ROOT)
      if (scheme != "http" && scheme != "https") return false
      return runCatching {
        val intent = Intent(Intent.ACTION_VIEW, uri)
        intent.addCategory(Intent.CATEGORY_BROWSABLE)
        startActivity(intent)
        true
      }.getOrDefault(false)
    }

    @JavascriptInterface
    fun beginPdfRender(sessionId: String?, dataUrl: String?): String {
      return runCatching {
        val id = safePdfRenderSessionId(sessionId)
        val data = decodeDataUrl(dataUrl)
        val file = File(cacheDir, "wordhunter-pdf-render-$id.pdf")
        FileOutputStream(file).use { output ->
          output.write(data)
          output.fd.sync()
        }
        val descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
        val renderer = PdfRenderer(descriptor)
        synchronized(pdfRenderLock) {
          pdfRenderSessions.remove(id)?.close()
          pdfRenderSessions[id] = PdfRenderSession(file, descriptor, renderer)
        }
        JSONObject()
          .put("success", true)
          .put("pageCount", renderer.pageCount)
          .toString()
      }.getOrElse { error ->
        JSONObject()
          .put("success", false)
          .put("error", error.message ?: "Could not open PDF renderer.")
          .toString()
      }
    }

    @JavascriptInterface
    fun renderPdfPage(sessionId: String?, pageIndex: Int, renderWidth: Int): String {
      return runCatching {
        val id = safePdfRenderSessionId(sessionId)
        val session = synchronized(pdfRenderLock) {
          pdfRenderSessions[id] ?: error("PDF render session is not open.")
        }
        if (pageIndex < 0 || pageIndex >= session.renderer.pageCount) {
          error("PDF page index is out of range.")
        }
        session.renderer.openPage(pageIndex).use { page ->
          val sourceWidth = page.width.coerceAtLeast(1)
          val sourceHeight = page.height.coerceAtLeast(1)
          val targetWidth = renderWidth.coerceIn(512, 2400)
          val targetHeight = ((sourceHeight.toDouble() / sourceWidth.toDouble()) * targetWidth)
            .toInt()
            .coerceAtLeast(1)
          val bitmap = Bitmap.createBitmap(targetWidth, targetHeight, Bitmap.Config.ARGB_8888)
          try {
            bitmap.eraseColor(Color.WHITE)
            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            val bytes = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, bytes)
            JSONObject()
              .put("success", true)
              .put("width", targetWidth)
              .put("height", targetHeight)
              .put("dataUrl", "data:image/png;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP))
              .toString()
          } finally {
            bitmap.recycle()
          }
        }
      }.getOrElse { error ->
        JSONObject()
          .put("success", false)
          .put("error", error.message ?: "Could not render PDF page.")
          .toString()
      }
    }

    @JavascriptInterface
    fun endPdfRender(sessionId: String?) {
      val id = safePdfRenderSessionId(sessionId)
      synchronized(pdfRenderLock) {
        pdfRenderSessions.remove(id)?.close()
      }
    }
  }

  private class PdfRenderSession(
    private val file: File,
    val descriptor: ParcelFileDescriptor,
    val renderer: PdfRenderer
  ) {
    fun close() {
      runCatching { renderer.close() }
      runCatching { descriptor.close() }
      if (file.exists() && !file.delete()) {
        Log.w("WordHunter", "Could not delete PDF render temp: ${file.absolutePath}")
      }
    }
  }

  private fun closeAllPdfRenderSessions() {
    val sessions = synchronized(pdfRenderLock) {
      val values = pdfRenderSessions.values.toList()
      pdfRenderSessions.clear()
      values
    }
    sessions.forEach { it.close() }
  }

  private fun safePdfRenderSessionId(value: String?): String {
    val raw = value?.takeIf { it.isNotBlank() } ?: "default"
    return raw.replace(Regex("[^A-Za-z0-9._-]"), "_").take(80).ifBlank { "default" }
  }

  private fun decodeDataUrl(dataUrl: String?): ByteArray {
    val raw = dataUrl?.substringAfter(',', dataUrl)?.trim()?.takeIf { it.isNotEmpty() }
      ?: error("PDF data is empty.")
    val maxEncodedLength = 128 * 1024 * 1024 * 4 / 3 + 4
    if (raw.length > maxEncodedLength) {
      error("PDF is too large for Pocket render (max 128 MB).")
    }
    val data = Base64.decode(raw, Base64.DEFAULT)
    if (data.size > 128 * 1024 * 1024) {
      error("PDF is too large for Pocket render (max 128 MB).")
    }
    return data
  }

  private fun localeFor(lang: String): Locale {
    return when (lang.substringBefore('-').lowercase(Locale.ROOT)) {
      "de" -> Locale.GERMANY
      "fr" -> Locale.FRANCE
      "it" -> Locale.ITALY
      "ja" -> Locale.JAPAN
      "es" -> Locale.forLanguageTag("es-ES")
      "pl" -> Locale.forLanguageTag("pl-PL")
      "ru" -> Locale.forLanguageTag("ru-RU")
      "uk" -> Locale.forLanguageTag("uk-UA")
      "en" -> Locale.US
      else -> Locale.forLanguageTag(lang)
    }
  }

  private fun syncSelectedFolder(uri: Uri, persistPermission: Boolean = true, token: String? = null): String {
    if (persistPermission) {
      val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
      runCatching { contentResolver.takePersistableUriPermission(uri, flags) }
    }

    val folder = DocumentFile.fromTreeUri(this, uri)
      ?: error("Selected folder is not available.")
    if (!folder.isDirectory) error("Selected target is not a folder.")

    val stagingRoot = prepareSyncStagingRoot()
    try {
      val incomingDir = File(stagingRoot, "incoming")
      copyDocumentTreeToFile(folder, incomingDir, root = true)
      syncStagedDirectoryWithRust(token)
      copyFileTreeToDocument(incomingDir, folder, root = true)
    } finally {
      cleanupSyncStaging(stagingRoot)
    }

    val label = folder.name?.takeIf { it.isNotBlank() } ?: uri.toString()
    val prefs = getSharedPreferences("wordhunter-sync", MODE_PRIVATE).edit()
      .putString("sync_label", label)
    if (persistPermission) prefs.putString("sync_uri", uri.toString())
    prefs.apply()
    return label
  }

  private fun savedSyncFolderUri(): Uri? {
    val raw = getSharedPreferences("wordhunter-sync", MODE_PRIVATE)
      .getString("sync_uri", null)
      ?: return null
    return runCatching { Uri.parse(raw) }.getOrNull()
  }

  private fun syncFolderPickerIntent(): Intent {
    return Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
      addFlags(
        Intent.FLAG_GRANT_READ_URI_PERMISSION or
          Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
          Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
          Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
      )
      putExtra("android.content.extra.SHOW_ADVANCED", true)
      putExtra("android.provider.extra.SHOW_ADVANCED", true)
      val initialUri = savedSyncFolderUri() ?: defaultSyncTreeUri()
      if (initialUri != null) {
        putExtra(DocumentsContract.EXTRA_INITIAL_URI, initialUri)
      }
    }
  }

  private fun defaultSyncTreeUri(): Uri? {
    return runCatching {
      DocumentsContract.buildTreeDocumentUri("com.android.externalstorage.documents", "primary:Documents")
    }.getOrNull()
  }

  private fun prepareSyncStagingRoot(): File {
    val stagingRoot = File(cacheDir, "wordhunter-sync-staging")
    if (stagingRoot.exists() && !stagingRoot.deleteRecursively()) {
      error("Cannot clean previous sync staging folder.")
    }
    if (!stagingRoot.mkdirs()) {
      error("Cannot create sync staging folder.")
    }
    return stagingRoot
  }

  private fun cleanupSyncStaging(stagingRoot: File) {
    if (stagingRoot.exists() && !stagingRoot.deleteRecursively()) {
      Log.w("WordHunter", "Could not delete sync staging folder: ${stagingRoot.absolutePath}")
    }
  }

  private fun syncStagedDirectoryWithRust(token: String?) {
    val syncToken = token?.takeIf { it.isNotBlank() }
      ?: error("Sync token is unavailable.")
    val connection = (URL("http://127.0.0.1:38619/__store/sync_android_staging")
      .openConnection() as HttpURLConnection)
    try {
      connection.requestMethod = "POST"
      connection.connectTimeout = 15000
      connection.readTimeout = 120000
      connection.doOutput = true
      connection.setFixedLengthStreamingMode(0)
      connection.setRequestProperty("X-WH-Token", syncToken)
      connection.outputStream.use { }
      val status = connection.responseCode
      if (status !in 200..299) {
        val message = connection.errorStream
          ?.bufferedReader()
          ?.use { it.readText() }
          ?.takeIf { it.isNotBlank() }
          ?: "Sync backend HTTP $status"
        error(message)
      }
      connection.inputStream?.close()
    } finally {
      connection.disconnect()
    }
  }

  private fun copyDocumentTreeToFile(
    source: DocumentFile,
    target: File,
    root: Boolean = false,
    relativePath: String = ""
  ) {
    if (!target.exists() && !target.mkdirs()) {
      error("Cannot create sync staging path ${target.name}.")
    }
    source.listFiles().forEach { child ->
      val name = child.name?.takeIf { isSafeSyncName(it) } ?: return@forEach
      val childRelativePath = if (root) name else childRelativePath(relativePath, name)
      if (!shouldSyncRelativePath(childRelativePath, child.isDirectory)) return@forEach
      val destination = File(target, name)
      if (child.isDirectory) {
        if (destination.exists() && !destination.isDirectory) {
          error("Cannot stage folder over file $childRelativePath.")
        }
        copyDocumentTreeToFile(child, destination, relativePath = childRelativePath)
      } else if (child.isFile) {
        copyDocumentFileToFile(child, destination)
      }
    }
  }

  private fun copyFileTreeToDocument(
    source: File,
    target: DocumentFile,
    root: Boolean = false,
    relativePath: String = ""
  ) {
    if (!source.exists()) return
    source.listFiles()?.forEach { child ->
      if (!isSafeSyncName(child.name)) return@forEach
      val childRelativePath = if (root) child.name else childRelativePath(relativePath, child.name)
      if (!shouldSyncRelativePath(childRelativePath, child.isDirectory)) return@forEach
      if (child.isDirectory) {
        val existing = target.findFile(child.name)
        if (existing != null && !existing.isDirectory) {
          error("Cannot export folder over file $childRelativePath.")
        }
        val destination = existing
          ?: target.createDirectory(child.name)
          ?: error("Cannot create ${child.name}.")
        copyFileTreeToDocument(child, destination, relativePath = childRelativePath)
      } else if (child.isFile) {
        if (isIncompleteLocalRecordFile(child)) return@forEach
        copyFileToDocument(child, target)
      }
    }
  }

  private fun copyFileToDocument(source: File, target: DocumentFile) {
    val existing = target.findFile(source.name)
    if (existing != null && !existing.isFile) {
      error("Cannot export file over folder ${source.name}.")
    }
    if (isSyncRecordFile(source)) {
      val localRecord = runCatching { source.readText() }.getOrNull() ?: return
      if (existing != null && readDocumentText(existing) == localRecord) return
    }
    val tempName = "${source.name}.tmp"
    val staleTemp = target.findFile(tempName)
    if (staleTemp != null && !staleTemp.delete()) {
      error("Cannot clean stale temp file $tempName.")
    }
    val temp = target.createFile(mimeFor(source.name), tempName)
      ?: error("Cannot create $tempName.")
    var replacing = false
    try {
      val expectedLength = source.length()
      contentResolver.openOutputStream(temp.uri, "wt")?.use { output ->
        source.inputStream().use { input ->
          val copied = input.copyTo(output)
          if (expectedLength >= 0L && copied != expectedLength) {
            error("Incomplete export for ${source.name}.")
          }
        }
      } ?: error("Cannot write $tempName.")
      val tempLength = temp.length()
      if (expectedLength >= 0L && tempLength > 0L && tempLength != expectedLength) {
        error("Incomplete exported temp for ${source.name}.")
      }
      replaceDocumentWithTemp(temp, existing, source.name)
      replacing = true
    } catch (error: Throwable) {
      if (!replacing) temp.delete()
      throw error
    }
  }

  private fun replaceDocumentWithTemp(temp: DocumentFile, existing: DocumentFile?, finalName: String) {
    if (existing == null) {
      if (!temp.renameTo(finalName)) {
        error("Cannot finalize $finalName.")
      }
      return
    }
    val backupName = "$finalName.whsync-old-${System.nanoTime()}"
    if (!existing.renameTo(backupName)) {
      error("Cannot prepare $finalName for replacement.")
    }
    try {
      if (!temp.renameTo(finalName)) {
        error("Cannot finalize $finalName.")
      }
      if (!existing.delete()) {
        Log.w("WordHunter", "Could not delete SAF sync backup: $backupName")
      }
    } catch (error: Throwable) {
      if (!existing.renameTo(finalName)) {
        Log.w("WordHunter", "Could not restore SAF sync backup: $backupName")
      }
      throw error
    }
  }

  private fun copyDocumentFileToFile(source: DocumentFile, destination: File) {
    val parent = destination.parentFile ?: error("Sync target has no parent.")
    if (!parent.exists() && !parent.mkdirs()) {
      error("Cannot create ${parent.name}.")
    }
    if (destination.exists() && destination.isDirectory) {
      error("Cannot replace folder with file ${destination.name}.")
    }
    val temp = File(parent, ".${destination.name}.whsync-tmp-${System.nanoTime()}")
    try {
      val expectedLength = source.length()
      contentResolver.openInputStream(source.uri)?.use { input ->
        FileOutputStream(temp).use { output ->
          val copied = input.copyTo(output)
          output.fd.sync()
          if (expectedLength > 0L && copied != expectedLength) {
            error("Incomplete import for ${destination.name}.")
          }
        }
      } ?: error("Cannot read ${destination.name}.")
      if (expectedLength > 0L && temp.length() != expectedLength) {
        error("Incomplete staged copy for ${destination.name}.")
      }
      val modified = source.lastModified()
      temp.setLastModified(if (modified > 0L) modified else 0L)
      if (destination.exists() && destination.isDirectory) {
        error("Cannot replace folder with file ${destination.name}.")
      }
      if (temp.renameTo(destination)) return
      val backup = File(parent, ".${destination.name}.whsync-old-${System.nanoTime()}")
      var backedUp = false
      try {
        if (destination.exists()) {
          if (!destination.renameTo(backup)) {
            error("Cannot prepare ${destination.name} for replacement.")
          }
          backedUp = true
        }
        if (!temp.renameTo(destination)) {
          error("Cannot finalize ${destination.name}.")
        }
        if (backedUp && backup.exists() && !backup.delete()) {
          Log.w("WordHunter", "Could not delete sync backup: ${backup.absolutePath}")
        }
      } catch (error: Throwable) {
        if (!destination.exists() && backedUp && backup.exists()) {
          backup.renameTo(destination)
        }
        throw error
      } finally {
        temp.delete()
      }
    } catch (error: Throwable) {
      temp.delete()
      throw error
    }
  }

  private fun childRelativePath(parent: String, child: String): String {
    return if (parent.isBlank()) child else "$parent/$child"
  }

  private fun shouldSyncRelativePath(relativePath: String, isDirectory: Boolean): Boolean {
    val rootName = relativePath.substringBefore("/")
    if (rootName !in knownDataNames) return false
    val name = relativePath.substringAfterLast("/")
    if (!isSafeSyncName(name)) return false
    if (!isDirectory && rootName == "books" && name in skippedBookRecordNames) return false
    if (rootName == "records") {
      val inRecordsV1 = relativePath == "records/v1" || relativePath.startsWith("records/v1/")
      return if (isDirectory) {
        relativePath == "records" || inRecordsV1
      } else {
        inRecordsV1 && isSyncRecordName(name)
      }
    }
    return true
  }

  private fun isSafeSyncName(name: String): Boolean {
    return name.isNotBlank() &&
      name != "." &&
      name != ".." &&
      !name.contains("/") &&
      !name.contains("\\") &&
      !isSyncTempName(name)
  }

  private fun isSyncTempName(name: String): Boolean {
    return name.endsWith(".tmp", ignoreCase = true) || name.contains(".whsync-")
  }

  private fun isIncompleteLocalRecordFile(source: File): Boolean {
    if (!isSyncRecordFile(source) || source.length() != 0L) return false
    Log.w("WordHunter", "Skipping empty local sync record: ${source.name}")
    return true
  }

  private fun isSyncRecordFile(file: File): Boolean {
    return isSyncRecordName(file.name) &&
      file.invariantSeparatorsPath.contains("/records/v1/")
  }

  private fun isSyncRecordName(name: String): Boolean {
    return name.endsWith(".json", ignoreCase = true) ||
      name.endsWith(".bak", ignoreCase = true)
  }

  private fun readDocumentText(file: DocumentFile): String? {
    return runCatching {
      contentResolver.openInputStream(file.uri)?.bufferedReader()?.use { it.readText() }
    }.getOrNull()
  }

  private fun mimeFor(name: String): String {
    return when {
      name.endsWith(".json", ignoreCase = true) -> "application/json"
      name.endsWith(".txt", ignoreCase = true) -> "text/plain"
      else -> "application/octet-stream"
    }
  }

  private fun dispatchAndroidSyncResult(
    success: Boolean,
    path: String?,
    error: String?,
    cancelled: Boolean
  ) {
    val detail = JSONObject()
      .put("success", success)
      .put("path", path ?: JSONObject.NULL)
      .put("error", error ?: JSONObject.NULL)
      .put("cancelled", cancelled)
    pendingSyncResult = detail
    dispatchPendingAndroidSyncResult()
  }

  private fun dispatchPendingAndroidSyncResult() {
    val detail = pendingSyncResult ?: return
    val script = "window.dispatchEvent(new CustomEvent('wordhunter:android-sync-folder',{detail:$detail}));"
    appWebView?.post {
      appWebView?.postDelayed({
        appWebView?.evaluateJavascript(script, null)
        if (pendingSyncResult === detail) pendingSyncResult = null
      }, 250)
    }
  }

  private fun dispatchAndroidTtsResult(
    utteranceId: String?,
    status: String,
    start: Int? = null,
    end: Int? = null
  ) {
    val detail = JSONObject()
      .put("id", utteranceId ?: JSONObject.NULL)
      .put("status", status)
    if (start != null) detail.put("start", start)
    if (end != null) detail.put("end", end)
    val script = "window.dispatchEvent(new CustomEvent('wordhunter:android-tts',{detail:$detail}));"
    appWebView?.post {
      appWebView?.evaluateJavascript(script, null)
    }
  }
}
