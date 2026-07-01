package com.wordhunter.pocket

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.documentfile.provider.DocumentFile
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.Locale
import java.util.concurrent.Executors

class MainActivity : TauriActivity() {
  private var appWebView: WebView? = null
  private var textToSpeech: TextToSpeech? = null
  private val syncExecutor = Executors.newSingleThreadExecutor()
  @Volatile private var ttsReady = false
  private var pendingSyncResult: JSONObject? = null
  private val knownDataNames = setOf(
    "store.sqlite",
    "store.sqlite-shm",
    "store.sqlite-wal",
    "vocab.json",
    "vocab.bak",
    "books",
    "records",
    "save-journal.json",
    "device-id.txt"
  )
  private val syncFolderLauncher = registerForActivityResult(
    ActivityResultContracts.OpenDocumentTree()
  ) { uri: Uri? ->
    if (uri == null) {
      dispatchAndroidSyncResult(success = false, path = null, error = null, cancelled = true)
      return@registerForActivityResult
    }

    syncExecutor.execute {
      runCatching { syncSelectedFolder(uri) }
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
    textToSpeech?.stop()
    textToSpeech?.shutdown()
    textToSpeech = null
    super.onDestroy()
  }

  inner class AndroidSyncBridge {
    @JavascriptInterface
    fun chooseSyncFolder() {
      runOnUiThread {
        syncFolderLauncher.launch(null)
      }
    }

    @JavascriptInterface
    fun forceSyncFolder(): Boolean {
      val uri = savedSyncFolderUri() ?: return false
      syncExecutor.execute {
        runCatching { syncSelectedFolder(uri, persistPermission = false) }
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

  private fun syncSelectedFolder(uri: Uri, persistPermission: Boolean = true): String {
    if (persistPermission) {
      val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
      runCatching { contentResolver.takePersistableUriPermission(uri, flags) }
    }

    val folder = DocumentFile.fromTreeUri(this, uri)
      ?: error("Selected folder is not available.")
    if (!folder.isDirectory) error("Selected target is not a folder.")

    val appDir = File(applicationInfo.dataDir, "WordHunter")
    appDir.mkdirs()
    copyDocumentTreeToFile(folder, appDir, root = true)
    copyFileTreeToDocument(appDir, folder, root = true)

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

  private fun copyDocumentTreeToFile(source: DocumentFile, target: File, root: Boolean = false) {
    target.mkdirs()
    source.listFiles().forEach { child ->
      val name = child.name ?: return@forEach
      if (root && name !in knownDataNames) return@forEach
      val destination = File(target, name)
      if (child.isDirectory) {
        copyDocumentTreeToFile(child, destination)
      } else if (child.isFile) {
        if (!shouldCopyDocumentFile(child, destination)) return@forEach
        if (destination.exists()) destination.deleteRecursively()
        destination.parentFile?.mkdirs()
        contentResolver.openInputStream(child.uri)?.use { input ->
          FileOutputStream(destination).use { output -> input.copyTo(output) }
        } ?: error("Cannot read $name.")
      }
    }
  }

  private fun copyFileTreeToDocument(source: File, target: DocumentFile, root: Boolean = false) {
    if (!source.exists()) return
    source.listFiles()?.forEach { child ->
      if (root && child.name !in knownDataNames) return@forEach
      if (child.isDirectory) {
        val destination = target.findFile(child.name)?.takeIf { it.isDirectory }
          ?: target.createDirectory(child.name)
          ?: error("Cannot create ${child.name}.")
        copyFileTreeToDocument(child, destination)
      } else if (child.isFile) {
        copyFileToDocument(child, target)
      }
    }
  }

  private fun shouldCopyDocumentFile(source: DocumentFile, destination: File): Boolean {
    if (!destination.exists()) return true
    if (isSyncRecordFile(destination)) {
      val remoteClock = syncRecordClock(readDocumentText(source))
      val localClock = syncRecordClock(runCatching { destination.readText() }.getOrNull())
      if (remoteClock != null && localClock != null) return remoteClock > localClock
    }
    val remoteModified = source.lastModified()
    val localModified = destination.lastModified()
    if (remoteModified > 0L && localModified > remoteModified) return false
    val remoteLength = source.length()
    if (remoteModified <= 0L && remoteLength >= 0L && remoteLength == destination.length()) return false
    return remoteModified <= 0L || remoteModified >= localModified || remoteLength != destination.length()
  }

  private fun copyFileToDocument(source: File, target: DocumentFile) {
    val existing = target.findFile(source.name)
    if (existing != null && isSyncRecordFile(source)) {
      val localClock = syncRecordClock(runCatching { source.readText() }.getOrNull())
      val remoteClock = syncRecordClock(readDocumentText(existing))
      if (localClock != null && remoteClock != null && localClock <= remoteClock) return
    }
    val tempName = "${source.name}.tmp"
    target.findFile(tempName)?.delete()
    val temp = target.createFile(mimeFor(source.name), tempName)
      ?: error("Cannot create $tempName.")
    var replacing = false
    try {
      contentResolver.openOutputStream(temp.uri, "wt")?.use { output ->
        source.inputStream().use { input -> input.copyTo(output) }
      } ?: error("Cannot write $tempName.")
      replacing = true
      existing?.delete()
      if (!temp.renameTo(source.name)) {
        error("Cannot finalize ${source.name}.")
      }
    } catch (error: Throwable) {
      if (!replacing) temp.delete()
      throw error
    }
  }

  private fun isSyncRecordFile(file: File): Boolean {
    return file.name.endsWith(".json", ignoreCase = true) &&
      file.invariantSeparatorsPath.contains("/records/v1/")
  }

  private fun readDocumentText(file: DocumentFile): String? {
    return runCatching {
      contentResolver.openInputStream(file.uri)?.bufferedReader()?.use { it.readText() }
    }.getOrNull()
  }

  private fun syncRecordClock(raw: String?): Long? {
    val value = raw?.takeIf { it.isNotBlank() } ?: return null
    return runCatching {
      val json = JSONObject(value)
      val updated = json.optString("updatedAt").toLongOrNull() ?: 0L
      val deleted = json.optString("deletedAt").toLongOrNull() ?: 0L
      maxOf(updated, deleted).takeIf { it > 0L }
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
