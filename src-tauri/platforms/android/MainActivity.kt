package com.wordhunter.pocket

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
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
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

private const val ANDROID_SYNC_TIMEOUT_MS = 180000L
private const val ANDROID_EXPORT_TIMEOUT_MS = 120000L
private const val ANDROID_EXPORT_MAX_CHARS = 32 * 1024 * 1024
private const val ANDROID_SYNC_MAX_ENTRIES = 100000
private const val ANDROID_SYNC_MAX_DEPTH = 8
private const val ANDROID_SYNC_MAX_FILE_BYTES = 256L * 1024L * 1024L
private const val ANDROID_SYNC_MAX_TOTAL_BYTES = 2L * 1024L * 1024L * 1024L
private const val ANDROID_SYNC_MARKER_NAME = ".wordhunter-sync.json"
private const val ANDROID_SYNC_MARKER_MAX_BYTES = 4096
private const val ANDROID_PDF_MAX_BITMAP_PIXELS = 8_000_000
private const val TTS_NOTIFICATION_CHANNEL_ID = "wordhunter-tts"
private const val TTS_NOTIFICATION_ID = 1001

class MainActivity : TauriActivity() {
  private var appWebView: WebView? = null
  private var textToSpeech: TextToSpeech? = null
  private val syncExecutor = Executors.newSingleThreadExecutor()
  private val exportExecutor = Executors.newSingleThreadExecutor()
  private val mainHandler = Handler(Looper.getMainLooper())
  private val syncLock = Any()
  private val bridgeRequestCounter = AtomicLong()
  private val pdfRenderSessions = mutableMapOf<String, PdfRenderSession>()
  private val pdfRenderLock = Any()
  private var ttsNotificationPermissionRequested = false
  @Volatile private var ttsReady = false
  @Volatile private var activeSyncRequest: SyncRequest? = null
  @Volatile private var pendingSyncRequestId: String? = null
  @Volatile private var pendingExport: PendingExport? = null
  private var pendingSyncResult: JSONObject? = null
  private var pendingExportResult: JSONObject? = null
  private val recordDataNames = setOf("records")
  private val mediaDataNames = setOf("books")
  private val knownDataNames = recordDataNames + mediaDataNames
  private val syncRecordDirectoryNames = setOf(
    "profiles", "vocab", "texts", "prefs", "hidden", "books", "assets", "conflicts", "resolved-conflicts"
  )
  private val skippedBookRecordNames = setOf("book.json", "book.bak", "metadata.json", "text.txt")
  private val syncFolderLauncher = registerForActivityResult(
    ActivityResultContracts.StartActivityForResult()
  ) { result ->
    val request = activePendingPickerSyncRequest()
    pendingSyncRequestId = null
    if (request == null) {
      Log.w("WordHunter", "Ignoring stale Android sync picker result.")
      return@registerForActivityResult
    }
    val uri = result.data?.data
    if (result.resultCode != Activity.RESULT_OK) {
      completeSyncRequest(
        request = request,
        success = false,
        path = null,
        error = null,
        cancelled = true,
        status = "cancelled",
        health = syncHealthEnvelope("cancelled", saf = null, staging = null, backend = null)
      )
      return@registerForActivityResult
    }
    if (uri == null) {
      completeSyncRequest(
        request = request,
        success = false,
        path = null,
        error = "Android folder picker did not return a folder.",
        cancelled = true,
        status = "cancelled",
        health = syncHealthEnvelope("cancelled", saf = null, staging = null, backend = null)
      )
      return@registerForActivityResult
    }

    val grantFlags = result.data?.flags ?: 0
    syncExecutor.execute {
      runCatching { syncSelectedFolder(uri, request = request, grantFlags = grantFlags) }
        .onSuccess { syncResult ->
          completeSyncRequest(
            request = request,
            success = true,
            path = syncResult.label,
            error = null,
            cancelled = false,
            status = "completed",
            health = syncResult.health
          )
        }
        .onFailure { error ->
          val health = (error as? AndroidSyncFailure)?.health
            ?: syncHealthEnvelope("error", saf = null, staging = null, backend = null, lastError = error.message)
          completeSyncRequest(
            request = request,
            success = false,
            path = null,
            error = error.message,
            cancelled = false,
            status = "error",
            health = health
          )
        }
      }
  }
  private val exportDocumentLauncher = registerForActivityResult(
    ActivityResultContracts.StartActivityForResult()
  ) { result ->
    val export = pendingExport
    if (export == null) {
      Log.w("WordHunter", "Ignoring stale Android export result.")
      return@registerForActivityResult
    }
    val uri = result.data?.data
    if (result.resultCode != Activity.RESULT_OK || uri == null) {
      synchronized(syncLock) {
        if (pendingExport?.requestId == export.requestId) pendingExport = null
      }
      export.timeoutRunnable?.let { mainHandler.removeCallbacks(it) }
      dispatchAndroidExportResult(export.requestId, success = false, error = null, cancelled = true, status = "cancelled")
      return@registerForActivityResult
    }
    val readyToWrite = synchronized(syncLock) {
      if (pendingExport?.requestId != export.requestId) {
        false
      } else {
        export.timeoutRunnable?.let { mainHandler.removeCallbacks(it) }
        export.timeoutRunnable = null
        true
      }
    }
    if (!readyToWrite) return@registerForActivityResult
    dispatchAndroidExportProgress(export.requestId, "writing")
    exportExecutor.execute {
      val outcome = runCatching { writeExportDocument(uri, export.data) }
      val stillActive = synchronized(syncLock) {
        if (pendingExport?.requestId != export.requestId) false
        else {
          pendingExport = null
          true
        }
      }
      if (stillActive) {
        export.timeoutRunnable?.let { mainHandler.removeCallbacks(it) }
        outcome.onSuccess {
          dispatchAndroidExportResult(export.requestId, success = true, error = null, cancelled = false, status = "completed")
        }.onFailure { error ->
          dispatchAndroidExportResult(export.requestId, success = false, error = error.message, cancelled = false, status = "error")
        }
      }
    }
  }
  private val ttsNotificationPermissionLauncher = registerForActivityResult(
    ActivityResultContracts.RequestPermission()
  ) { granted ->
    if (granted && textToSpeech?.isSpeaking == true) showTtsNotification()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    textToSpeech = TextToSpeech(this) { status ->
      ttsReady = status == TextToSpeech.SUCCESS
    }
    textToSpeech?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
      override fun onStart(utteranceId: String?) {
        showTtsNotification()
      }

      override fun onDone(utteranceId: String?) {
        hideTtsNotification()
        dispatchAndroidTtsResult(utteranceId, "done")
      }

      @Deprecated("Deprecated in Android API")
      override fun onError(utteranceId: String?) {
        hideTtsNotification()
        dispatchAndroidTtsResult(utteranceId, "error")
      }

      override fun onStop(utteranceId: String?, interrupted: Boolean) {
        hideTtsNotification()
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
    dispatchPendingAndroidExportResult()
  }

  override fun onWebViewCreate(webView: WebView) {
    appWebView = webView
    webView.isVerticalScrollBarEnabled = false
    webView.isHorizontalScrollBarEnabled = false
    webView.overScrollMode = android.view.View.OVER_SCROLL_NEVER
    webView.addJavascriptInterface(AndroidSyncBridge(), "WordHunterAndroid")
    Log.i("WordHunter", "WebView created; parent=${webView.parent != null}")
    if (webView.parent == null) {
      setContentView(webView)
    }
  }

  override fun onDestroy() {
    synchronized(syncLock) {
      activeSyncRequest?.timeoutRunnable?.let { mainHandler.removeCallbacks(it) }
      pendingExport?.timeoutRunnable?.let { mainHandler.removeCallbacks(it) }
      activeSyncRequest = null
      pendingExport = null
      pendingSyncRequestId = null
    }
    syncExecutor.shutdownNow()
    exportExecutor.shutdownNow()
    closeAllPdfRenderSessions()
    hideTtsNotification()
    textToSpeech?.stop()
    textToSpeech?.shutdown()
    textToSpeech = null
    super.onDestroy()
  }

  inner class AndroidSyncBridge {
    @JavascriptInterface
    fun chooseSyncFolder(token: String?, requestId: String?): Boolean {
      val request = beginSyncRequest(requestId, token)
        ?: return dispatchAndroidSyncBusy(requestId)
      pendingSyncRequestId = request.id
      runOnUiThread {
        runCatching {
          dispatchAndroidSyncProgress(request, "picker")
          syncFolderLauncher.launch(syncFolderPickerIntent())
        }.onFailure { error ->
          completeSyncRequest(
            request = request,
            success = false,
            path = null,
            error = error.message,
            cancelled = false,
            status = "error",
            health = syncHealthEnvelope("error", saf = null, staging = null, backend = null, lastError = error.message)
          )
        }
      }
      return true
    }

    @JavascriptInterface
    fun forceSyncFolder(token: String?, requestId: String?): Boolean {
      val uri = savedSyncFolderUri() ?: return false
      val request = beginSyncRequest(requestId, token)
        ?: return dispatchAndroidSyncBusy(requestId)
      syncExecutor.execute {
        runCatching { syncSelectedFolder(uri, request = request, persistPermission = false) }
          .onSuccess { syncResult ->
            completeSyncRequest(
              request = request,
              success = true,
              path = syncResult.label,
              error = null,
              cancelled = false,
              status = "completed",
              health = syncResult.health
            )
          }
          .onFailure { error ->
            val health = (error as? AndroidSyncFailure)?.health
              ?: syncHealthEnvelope("error", saf = null, staging = null, backend = null, lastError = error.message)
            completeSyncRequest(
              request = request,
              success = false,
              path = null,
              error = error.message,
              cancelled = false,
              status = "error",
              health = health
            )
          }
      }
      return true
    }

    @JavascriptInterface
    fun cancelSyncFolder(requestId: String?): Boolean {
      val request = synchronized(syncLock) {
        activeSyncRequest?.takeIf { requestId.isNullOrBlank() || it.id == requestId }
      } ?: return false
      if (request.backendInProgress) {
        dispatchAndroidSyncProgress(
          request,
          "merging",
          syncHealthEnvelope("merging", saf = null, staging = null, backend = null)
        )
        return false
      }
      completeSyncRequest(
        request = request,
        success = false,
        path = null,
        error = null,
        cancelled = true,
        status = "cancelled",
        health = syncHealthEnvelope("cancelled", saf = null, staging = null, backend = null)
      )
      return true
    }

    @JavascriptInterface
    fun getSyncFolderLabel(): String? {
      val prefs = getSharedPreferences("wordhunter-sync", MODE_PRIVATE)
      return prefs.getString("sync_label", null) ?: prefs.getString("sync_uri", null)
    }

    @JavascriptInterface
    fun saveExport(data: String?, filename: String?, mime: String?, requestId: String?): Boolean {
      val payload = data ?: return false
      val id = normalizeBridgeRequestId(requestId, "android-export")
      if (payload.length > ANDROID_EXPORT_MAX_CHARS) {
        dispatchAndroidExportResult(id, success = false, error = "Pocket export exceeds the 32 MB safety limit.", cancelled = false, status = "too-large")
        return true
      }
      synchronized(syncLock) {
        if (pendingExport != null) {
          dispatchAndroidExportResult(id, success = false, error = "Android export is already running.", cancelled = false, status = "busy")
          return true
        }
        val export = PendingExport(
          requestId = id,
          data = payload,
          filename = safeExportFilename(filename),
          mime = safeMimeType(mime)
        )
        val timeout = Runnable {
          synchronized(syncLock) {
            if (pendingExport?.requestId == export.requestId) pendingExport = null
          }
          dispatchAndroidExportResult(export.requestId, success = false, error = "Android export timed out.", cancelled = false, status = "timeout")
        }
        export.timeoutRunnable = timeout
        pendingExport = export
        mainHandler.postDelayed(timeout, ANDROID_EXPORT_TIMEOUT_MS)
      }
      runOnUiThread {
        runCatching {
          exportDocumentLauncher.launch(createExportDocumentIntent(pendingExport?.filename ?: safeExportFilename(filename), pendingExport?.mime ?: safeMimeType(mime)))
        }.onFailure { error ->
          synchronized(syncLock) {
            pendingExport?.timeoutRunnable?.let { mainHandler.removeCallbacks(it) }
            pendingExport = null
          }
          dispatchAndroidExportResult(id, success = false, error = error.message, cancelled = false, status = "error")
        }
      }
      return true
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
        hideTtsNotification()
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
          if (targetHeight > ANDROID_PDF_MAX_BITMAP_PIXELS / targetWidth) {
            error("PDF page dimensions are too large to render safely.")
          }
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

  private data class SyncRequest(
    val id: String,
    val token: String?,
    val startedAtMs: Long = System.currentTimeMillis(),
    var timeoutRunnable: Runnable? = null,
    @Volatile var backendInProgress: Boolean = false
  )

  private data class SyncFolderResult(
    val label: String,
    val health: JSONObject
  )

  private class AndroidSyncFailure(
    message: String,
    val health: JSONObject
  ) : RuntimeException(message)

  private data class PendingExport(
    val requestId: String,
    val data: String,
    val filename: String,
    val mime: String,
    var timeoutRunnable: Runnable? = null
  )

  private class AndroidSyncStats {
    private val skippedRemote = mutableListOf<JSONObject>()
    private val initialRemoteDirectories = mutableSetOf<String>()
    private val initialRemoteFileDigests = mutableMapOf<String, ByteArray>()
    var skippedRemoteCount = 0
      private set
    var importedFileCount = 0
    var exportedFileCount = 0
    var processedExportFileCount = 0
    var localRecordCount = 0
    var remoteRecordCount = 0
    var stagedRemoteRecordCount = 0
    var exportedLocalRecordCount = 0
    var staleTempDeletedCount = 0
    var incompleteLocalRecordCount = 0
    var visitedRemoteEntryCount = 0
    var stagedRemoteBytes = 0L
    var deletedRemoteEntryCount = 0
    var visitedLocalEntryCount = 0
    var exportedLocalBytes = 0L
    var lastError: String? = null

    fun visitRemote(path: String) {
      visitedRemoteEntryCount += 1
      if (visitedRemoteEntryCount > ANDROID_SYNC_MAX_ENTRIES) {
        error("Android sync folder has too many entries (max $ANDROID_SYNC_MAX_ENTRIES): $path")
      }
    }

    fun ensureCanStage(path: String, fileBytes: Long) {
      if (fileBytes > ANDROID_SYNC_MAX_FILE_BYTES) {
        error("Android sync file is too large (max 256 MB): $path")
      }
      if (fileBytes > ANDROID_SYNC_MAX_TOTAL_BYTES - stagedRemoteBytes) {
        error("Android sync folder is too large to stage (max 2 GB).")
      }
    }

    fun recordRemoteDirectory(path: String) {
      initialRemoteDirectories.add(path)
    }

    fun recordStagedFile(path: String, fileBytes: Long, digest: ByteArray) {
      stagedRemoteBytes += fileBytes
      initialRemoteFileDigests[path] = digest
    }

    fun wasRemoteDirectory(path: String): Boolean = path in initialRemoteDirectories

    fun remoteFileDigest(path: String): ByteArray? = initialRemoteFileDigests[path]

    fun wasRemoteEntry(path: String): Boolean {
      return wasRemoteDirectory(path) || initialRemoteFileDigests.containsKey(path)
    }

    fun visitLocal(path: String, fileBytes: Long?) {
      visitedLocalEntryCount += 1
      if (visitedLocalEntryCount > ANDROID_SYNC_MAX_ENTRIES) {
        error("Local sync data has too many entries (max $ANDROID_SYNC_MAX_ENTRIES): $path")
      }
      if (fileBytes == null) return
      if (fileBytes > ANDROID_SYNC_MAX_FILE_BYTES) {
        error("Local sync file is too large (max 256 MB): $path")
      }
      if (fileBytes > ANDROID_SYNC_MAX_TOTAL_BYTES - exportedLocalBytes) {
        error("Local sync data is too large to export (max 2 GB).")
      }
      exportedLocalBytes += fileBytes
    }

    fun skipRemote(path: String, reason: String) {
      skippedRemoteCount += 1
      if (skippedRemote.size < 25) {
        skippedRemote.add(JSONObject().put("path", path).put("reason", reason))
      }
    }

    fun toJson(): JSONObject {
      return JSONObject()
        .put("skippedRemoteCount", skippedRemoteCount)
        .put("skippedRemote", skippedRemote)
        .put("importedFileCount", importedFileCount)
        .put("exportedFileCount", exportedFileCount)
        .put("processedExportFileCount", processedExportFileCount)
        .put("localRecordCount", localRecordCount)
        .put("remoteRecordCount", remoteRecordCount)
        .put("stagedRemoteRecordCount", stagedRemoteRecordCount)
        .put("exportedLocalRecordCount", exportedLocalRecordCount)
        .put("staleTempDeletedCount", staleTempDeletedCount)
        .put("incompleteLocalRecordCount", incompleteLocalRecordCount)
        .put("visitedRemoteEntryCount", visitedRemoteEntryCount)
        .put("stagedRemoteBytes", stagedRemoteBytes)
        .put("deletedRemoteEntryCount", deletedRemoteEntryCount)
        .put("visitedLocalEntryCount", visitedLocalEntryCount)
        .put("exportedLocalBytes", exportedLocalBytes)
        .put("lastError", lastError ?: JSONObject.NULL)
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

  private fun activePendingPickerSyncRequest(): SyncRequest? {
    val id = pendingSyncRequestId ?: return null
    return synchronized(syncLock) {
      activeSyncRequest?.takeIf { it.id == id }
    }
  }

  private fun beginSyncRequest(requestId: String?, token: String?): SyncRequest? {
    val request = SyncRequest(
      id = normalizeBridgeRequestId(requestId, "android-sync"),
      token = token?.takeIf { it.isNotBlank() }
    )
    synchronized(syncLock) {
      if (activeSyncRequest != null) return null
      activeSyncRequest = request
    }
    val timeout = Runnable {
      if (request.backendInProgress && isSyncRequestActive(request)) {
        dispatchAndroidSyncProgress(
          request,
          "merging-slow",
          syncHealthEnvelope("merging-slow", saf = null, staging = null, backend = null)
        )
        return@Runnable
      }
      completeSyncRequest(
        request = request,
        success = false,
        path = null,
        error = "Android sync timed out.",
        cancelled = false,
        status = "timeout",
        health = syncHealthEnvelope("timeout", saf = null, staging = null, backend = null, lastError = "Android sync timed out.")
      )
    }
    request.timeoutRunnable = timeout
    mainHandler.postDelayed(timeout, ANDROID_SYNC_TIMEOUT_MS)
    dispatchAndroidSyncProgress(request, "started")
    return request
  }

  private fun dispatchAndroidSyncBusy(requestId: String?): Boolean {
    val id = normalizeBridgeRequestId(requestId, "android-sync")
    val detail = JSONObject()
      .put("requestId", id)
      .put("success", false)
      .put("path", JSONObject.NULL)
      .put("error", "Android sync is already running.")
      .put("cancelled", false)
      .put("status", "busy")
      .put("terminal", true)
      .put("health", syncHealthEnvelope("busy", saf = null, staging = null, backend = null, lastError = "Android sync is already running."))
    dispatchAndroidSyncDetail(detail, terminal = true)
    return true
  }

  private fun isSyncRequestActive(request: SyncRequest): Boolean {
    return synchronized(syncLock) {
      activeSyncRequest?.id == request.id
    }
  }

  private fun ensureSyncActive(request: SyncRequest) {
    if (!isSyncRequestActive(request)) {
      error("Android sync request was cancelled or superseded.")
    }
  }

  private fun syncSelectedFolder(
    uri: Uri,
    request: SyncRequest,
    persistPermission: Boolean = true,
    grantFlags: Int = 0
  ): SyncFolderResult {
    val stats = AndroidSyncStats()
    var safHealth: JSONObject? = null
    var stagingHealth: JSONObject? = null
    var backendHealth: JSONObject? = null
    var stagingRoot: File? = null
    try {
      ensureSyncActive(request)
      dispatchAndroidSyncProgress(request, "verifying-permission")
      val permission = if (persistPermission) {
        persistSyncPermission(uri, grantFlags)
      } else {
        savedSyncPermission(uri)
      }

      val folder = DocumentFile.fromTreeUri(this, uri)
        ?: error("Selected folder is not available.")
      if (!folder.isDirectory) error("Selected target is not a folder.")
      safHealth = verifySafSyncFolder(uri, folder, permission)
      val label = rememberSyncFolder(uri, folder, persistPermission)
      dispatchAndroidSyncProgress(
        request,
        "folder-selected",
        syncHealthEnvelope("folder-selected", safHealth, stagingHealth, backendHealth),
        path = label
      )

      dispatchAndroidSyncProgress(request, "staging-remote", syncHealthEnvelope("staging-remote", safHealth, stagingHealth, backendHealth))
      stagingRoot = prepareSyncStagingRoot(request)
      val incomingDir = File(stagingRoot, "incoming")
      copyDocumentTreeToFile(
        folder,
        incomingDir,
        request = request,
        stats = stats,
        root = true,
        recordsOnly = false
      )
      stats.localRecordCount = listLocalRecordFiles(localRecordsRoot(), stats).size
      stats.remoteRecordCount = listLocalRecordFiles(File(incomingDir, "records/v1"), stats).size
      stagingHealth = stagingHealth(stagingRoot, incomingDir, "remote-staged", stats = stats)
      dispatchAndroidSyncProgress(request, "merging", syncHealthEnvelope("merging", safHealth, stagingHealth, backendHealth))
      request.backendInProgress = true
      backendHealth = try {
        syncStagedDirectoryWithRust(request)
      } finally {
        request.backendInProgress = false
      }
      appWebView?.post { appWebView?.clearCache(true) }
      stagingHealth = stagingHealth(stagingRoot, incomingDir, "merged", stats = stats, backend = backendHealth)
      dispatchAndroidSyncProgress(request, "exporting", syncHealthEnvelope("exporting", safHealth, stagingHealth, backendHealth))
      validateLocalExportTree(incomingDir, stats, root = true)
      copyFileTreeToDocument(
        incomingDir,
        folder,
        request = request,
        stats = stats,
        root = true,
        recordsOnly = false
      )

      stagingHealth = stagingHealth(stagingRoot, incomingDir, "exported", stats = stats, backend = backendHealth)
      return SyncFolderResult(
        label = label,
        health = syncHealthEnvelope("completed", safHealth, stagingHealth, backendHealth)
      )
    } catch (error: Throwable) {
      stats.lastError = error.message
      stagingRoot?.let {
        stagingHealth = stagingHealth(it, File(it, "incoming"), "failed", stats = stats, backend = backendHealth, lastError = error.message)
      }
      throw AndroidSyncFailure(
        error.message ?: "Android sync failed.",
        syncHealthEnvelope("error", safHealth, stagingHealth, backendHealth, lastError = error.message)
      )
    } finally {
      stagingRoot?.let {
        val status = if (stats.lastError == null) "cleaning" else "failed"
        stagingHealth = stagingHealth(it, File(it, "incoming"), status, stats = stats, backend = backendHealth, lastError = stats.lastError)
        cleanupSyncStaging(it)
      }
    }
  }

  private fun savedSyncFolderUri(): Uri? {
    val raw = getSharedPreferences("wordhunter-sync", MODE_PRIVATE)
      .getString("sync_uri", null)
      ?: return null
    return runCatching { Uri.parse(raw) }.getOrNull()
  }

  private fun rememberSyncFolder(uri: Uri, folder: DocumentFile, persistPermission: Boolean): String {
    val label = folder.name?.takeIf { it.isNotBlank() } ?: uri.toString()
    val prefs = getSharedPreferences("wordhunter-sync", MODE_PRIVATE).edit()
      .putString("sync_label", label)
    if (persistPermission) prefs.putString("sync_uri", uri.toString())
    if (!prefs.commit()) {
      error("Cannot save selected sync folder.")
    }
    return label
  }

  private fun persistSyncPermission(uri: Uri, grantFlags: Int): JSONObject {
    val readFlag = Intent.FLAG_GRANT_READ_URI_PERMISSION
    val writeFlag = Intent.FLAG_GRANT_WRITE_URI_PERMISSION
    val requiredFlags = readFlag or writeFlag
    val granted = grantFlags and requiredFlags
    if ((granted and readFlag) == 0) {
      error("Selected sync folder did not grant read permission.")
    }
    if ((granted and writeFlag) == 0) {
      error("Selected sync folder did not grant write permission.")
    }
    runCatching {
      contentResolver.takePersistableUriPermission(uri, granted)
    }.getOrElse { cause ->
      error("Cannot persist sync folder permission: ${cause.message ?: cause.javaClass.simpleName}")
    }
    return savedSyncPermission(uri).put("grantFlags", granted)
  }

  private fun savedSyncPermission(uri: Uri): JSONObject {
    val persisted = contentResolver.persistedUriPermissions
      .firstOrNull { it.uri == uri || it.uri.toString() == uri.toString() }
    val hasRead = persisted?.isReadPermission == true
    val hasWrite = persisted?.isWritePermission == true
    if (!hasRead || !hasWrite) {
      error("Persisted sync folder permission is missing read/write access.")
    }
    return JSONObject()
      .put("persisted", true)
      .put("read", hasRead)
      .put("write", hasWrite)
      .put("uri", uri.toString())
  }

  private fun verifySafSyncFolder(uri: Uri, folder: DocumentFile, permission: JSONObject): JSONObject {
    val entries = runCatching { folder.listFiles() }
      .getOrElse { error("Cannot list selected sync folder: ${it.message ?: it.javaClass.simpleName}") }
    val ownership = verifySyncFolderOwnership(folder, entries)
    val probeName = ".wordhunter.whsync-probe-${System.nanoTime()}.tmp"
    folder.findFile(probeName)?.delete()
    val probe = folder.createFile("application/octet-stream", probeName)
      ?: error("Cannot create temporary sync permission probe.")
    var deleted = false
    try {
      val bytes = "ok".toByteArray(Charsets.UTF_8)
      contentResolver.openOutputStream(probe.uri, "wt")?.use { output ->
        output.write(bytes)
        output.flush()
      } ?: error("Cannot write temporary sync permission probe.")
      val readBack = contentResolver.openInputStream(probe.uri)
        ?.bufferedReader(Charsets.UTF_8)
        ?.use { it.readText() }
        ?: error("Cannot read temporary sync permission probe.")
      if (readBack != "ok") {
        error("Temporary sync permission probe readback failed.")
      }
      if (!probe.delete()) {
        error("Cannot delete temporary sync permission probe.")
      }
      deleted = true
    } finally {
      if (!deleted) probe.delete()
    }
    return JSONObject()
      .put("status", "ready")
      .put("uri", uri.toString())
      .put("permission", permission)
      .put("canList", true)
      .put("canCreate", true)
      .put("canWrite", true)
      .put("canRead", true)
      .put("canDelete", true)
      .put("entryCount", entries.size)
      .put("ownership", ownership)
  }

  private fun verifySyncFolderOwnership(folder: DocumentFile, entries: Array<DocumentFile>): String {
    val marker = entries.firstOrNull { it.name == ANDROID_SYNC_MARKER_NAME }
    if (marker != null) {
      if (!marker.isFile) error("Word Hunter sync marker is not a file.")
      val raw = readDocumentTextLimited(marker, ANDROID_SYNC_MARKER_MAX_BYTES)
      val payload = runCatching { JSONObject(raw) }
        .getOrElse { error("Word Hunter sync marker is invalid.") }
      if (payload.optString("app") != "WordHunter" || payload.optInt("schemaVersion") != 1) {
        error("Selected folder belongs to an unsupported sync format.")
      }
      return "verified"
    }

    val allowedLegacyNames = knownDataNames + setOf(
      "argos-packages", ".stfolder", ".stversions", ".stignore", ".DS_Store", "desktop.ini", "Thumbs.db"
    )
    val entryNames = entries.mapNotNull { it.name }
    val unexpected = entryNames.filter { it !in allowedLegacyNames && !it.startsWith(".stfolder.removed-") }
    if (unexpected.isNotEmpty()) {
      error("Select a dedicated or existing Word Hunter sync folder; this folder contains unrelated files.")
    }
    val hasWordHunterData = entryNames.any { it in knownDataNames || it == "argos-packages" }
    val recordsV1 = folder.findFile("records")?.takeIf { it.isDirectory }?.findFile("v1")
    if (hasWordHunterData && recordsV1?.isDirectory != true) {
      error("Existing Word Hunter data is incomplete: records/v1 is missing.")
    }
    val created = folder.createFile("application/json", ANDROID_SYNC_MARKER_NAME)
      ?: error("Cannot create Word Hunter sync ownership marker.")
    val markerBytes = JSONObject()
      .put("app", "WordHunter")
      .put("schemaVersion", 1)
      .toString()
      .toByteArray(Charsets.UTF_8)
    contentResolver.openOutputStream(created.uri, "wt")?.use { output ->
      output.write(markerBytes)
      output.flush()
    } ?: error("Cannot write Word Hunter sync ownership marker.")
    return if (entries.isEmpty()) "created" else "migrated"
  }

  private fun readDocumentTextLimited(document: DocumentFile, maxBytes: Int): String {
    val output = ByteArrayOutputStream()
    contentResolver.openInputStream(document.uri)?.use { input ->
      val buffer = ByteArray(1024)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        if (output.size() + count > maxBytes) error("Word Hunter sync marker is too large.")
        output.write(buffer, 0, count)
      }
    } ?: error("Cannot read Word Hunter sync ownership marker.")
    return output.toString(Charsets.UTF_8.name())
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

  private fun prepareSyncStagingRoot(request: SyncRequest): File {
    val stagingParent = File(cacheDir, "wordhunter-sync-staging")
    if (!stagingParent.exists() && !stagingParent.mkdirs()) {
      error("Cannot create sync staging parent folder.")
    }
    val stagingRoot = File(stagingParent, request.id)
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

  private fun syncStagedDirectoryWithRust(request: SyncRequest): JSONObject {
    ensureSyncActive(request)
    val syncToken = request.token
      ?: error("Sync token is unavailable.")
    val connection = (URL("http://127.0.0.1:38619/__store/sync_android_staging")
      .openConnection() as HttpURLConnection)
    try {
      connection.requestMethod = "POST"
      connection.connectTimeout = 15000
      connection.readTimeout = 0
      connection.doOutput = true
      val body = JSONObject().put("requestId", request.id).toString().toByteArray(Charsets.UTF_8)
      connection.setFixedLengthStreamingMode(body.size)
      connection.setRequestProperty("Content-Type", "application/json")
      connection.setRequestProperty("X-WH-Token", syncToken)
      connection.outputStream.use { output -> output.write(body) }
      val status = connection.responseCode
      if (status !in 200..299) {
        val message = connection.errorStream
          ?.bufferedReader()
          ?.use { it.readText() }
          ?.takeIf { it.isNotBlank() }
          ?: "Sync backend HTTP $status"
        error(message)
      }
      val raw = connection.inputStream
        ?.bufferedReader()
        ?.use { it.readText() }
        ?: "{}"
      ensureSyncActive(request)
      return runCatching { compactBackendSyncResult(JSONObject(raw)) }
        .getOrElse {
          JSONObject()
            .put("status", "synced")
            .put("raw", raw)
        }
    } finally {
      connection.disconnect()
    }
  }

  private fun compactBackendSyncResult(raw: JSONObject): JSONObject {
    val compact = JSONObject()
      .put("status", raw.optString("status", "synced"))

    raw.optJSONObject("health")?.let { compact.put("health", it) }
    raw.optJSONObject("summary")?.let { compact.put("summary", it) }
    raw.optJSONObject("snapshot")?.let { snapshot ->
      val summary = compact.optJSONObject("summary") ?: JSONObject()
      snapshot.optJSONArray("texts")?.let { summary.put("textCount", it.length()) }
      summary.put("vocabCount", countSnapshotVocab(snapshot.optJSONObject("vocab")))
      if (snapshot.has("syncConflictCount")) {
        summary.put("syncConflictCount", snapshot.opt("syncConflictCount"))
      }
      snapshot.optJSONObject("recoveryStatus")?.let { summary.put("recoveryStatus", it) }
      compact.put("summary", summary)
    }

    return compact
  }

  private fun countSnapshotVocab(vocabRoot: JSONObject?): Int {
    if (vocabRoot == null) return 0
    var count = 0
    val languages = vocabRoot.keys()
    while (languages.hasNext()) {
      val language = languages.next()
      count += vocabRoot.optJSONObject(language)?.optJSONObject("vocab")?.length() ?: 0
    }
    return count
  }

  private fun localRecordsRoot(): File {
    return File(applicationInfo.dataDir, "WordHunter/records/v1")
  }

  private fun listLocalRecordFiles(root: File, stats: AndroidSyncStats): Map<String, File> {
    val records = linkedMapOf<String, File>()
    fun visit(dir: File, relativePath: String) {
      dir.listFiles()?.forEach { child ->
        if (!isSafeSyncName(child.name)) return@forEach
        val childRelativePath = childRelativePath(relativePath, child.name)
        if (child.isDirectory) {
          if (relativePath.isBlank() && child.name !in syncRecordDirectoryNames) return@forEach
          visit(child, childRelativePath)
        } else if (child.isFile && isSyncRecordName(child.name) && !isIncompleteLocalRecordFile(child, stats)) {
          records[childRelativePath] = child
        }
      }
    }
    if (root.isDirectory) visit(root, "")
    return records
  }

  private fun ensureDocumentDirectoryPath(root: DocumentFile, parts: List<String>): DocumentFile {
    var current = root
    for (part in parts) {
      if (!isSafeSyncName(part)) error("Unsafe sync folder name $part.")
      val children = current.listFiles().mapNotNull { child -> child.name?.let { name -> name to child } }.toMap()
      val existing = children[part]
      if (existing != null && !existing.isDirectory) {
        error("Cannot create sync folder over file $part.")
      }
      current = existing ?: current.createDirectory(part) ?: error("Cannot create sync folder $part.")
    }
    return current
  }

  private fun copyDocumentTreeToFile(
    source: DocumentFile,
    target: File,
    request: SyncRequest,
    stats: AndroidSyncStats,
    root: Boolean = false,
    relativePath: String = "",
    recordsOnly: Boolean = false,
    depth: Int = 0
  ) {
    ensureSyncActive(request)
    if (depth > ANDROID_SYNC_MAX_DEPTH) {
      error("Android sync folder nesting is too deep (max $ANDROID_SYNC_MAX_DEPTH): $relativePath")
    }
    if (!target.exists() && !target.mkdirs()) {
      error("Cannot create sync staging path ${target.name}.")
    }
    source.listFiles().forEach { child ->
      ensureSyncActive(request)
      val rawName = child.name ?: "(unnamed)"
      val name = rawName.takeIf { isSafeSyncName(it) }
      if (name == null) {
        stats.skipRemote(childRelativePath(relativePath, rawName), "unsafe-name")
        return@forEach
      }
      val childRelativePath = if (root) name else childRelativePath(relativePath, name)
      stats.visitRemote(childRelativePath)
      if (!shouldSyncRelativePath(childRelativePath, child.isDirectory, recordsOnly)) {
        if (isObsoleteLocalOnlySyncPath(childRelativePath)) {
          inventoryObsoleteDocumentTree(child, childRelativePath, request, stats, depth + 1)
        }
        stats.skipRemote(childRelativePath, "not-in-android-allowlist")
        return@forEach
      }
      val destination = File(target, name)
      if (child.isDirectory) {
        stats.recordRemoteDirectory(childRelativePath)
        if (destination.exists() && !destination.isDirectory) {
          error("Cannot stage folder over file $childRelativePath.")
        }
        copyDocumentTreeToFile(child, destination, request = request, stats = stats, relativePath = childRelativePath, recordsOnly = recordsOnly, depth = depth + 1)
      } else if (child.isFile) {
        copyDocumentFileToFile(child, destination, childRelativePath, request = request, stats = stats)
        if (stats.importedFileCount % 100 == 0) {
          dispatchAndroidSyncProgress(request, "staging-remote")
        }
      }
    }
  }

  private fun copyFileTreeToDocument(
    source: File,
    target: DocumentFile,
    request: SyncRequest,
    stats: AndroidSyncStats,
    root: Boolean = false,
    relativePath: String = "",
    recordsOnly: Boolean = false
  ) {
    ensureSyncActive(request)
    if (!source.exists()) return
    val targetChildren = target.listFiles().mapNotNull { child ->
      child.name?.let { name -> name to child }
    }.toMap()
    val sourceNames = mutableSetOf<String>()
    val sourceChildren = source.listFiles()
      ?: error("Cannot list local sync staging path $relativePath.")
    sourceChildren.forEach { child ->
      ensureSyncActive(request)
      if (!isSafeSyncName(child.name)) return@forEach
      val childRelativePath = if (root) child.name else childRelativePath(relativePath, child.name)
      if (!shouldSyncRelativePath(childRelativePath, child.isDirectory, recordsOnly)) return@forEach
      sourceNames.add(child.name)
      if (child.isDirectory) {
        val existing = targetChildren[child.name]
        if (existing != null && !existing.isDirectory) {
          error("Cannot export folder over file $childRelativePath.")
        }
        if (existing != null && !stats.wasRemoteDirectory(childRelativePath)) {
          error("Sync folder changed while syncing: $childRelativePath")
        }
        if (existing == null && stats.wasRemoteEntry(childRelativePath)) {
          error("Sync folder entry was removed while syncing: $childRelativePath")
        }
        val destination = existing ?: target.createDirectory(child.name)
          ?: error("Cannot create ${child.name}.")
        copyFileTreeToDocument(child, destination, request = request, stats = stats, relativePath = childRelativePath, recordsOnly = recordsOnly)
      } else if (child.isFile) {
        if (isIncompleteLocalRecordFile(child, stats)) return@forEach
        copyFileToDocument(child, target, targetChildren[child.name], childRelativePath, request, stats)
        stats.processedExportFileCount += 1
        if (stats.processedExportFileCount % 100 == 0) {
          dispatchAndroidSyncProgress(request, "exporting")
        }
      }
    }
    targetChildren.forEach { (name, child) ->
      if (name in sourceNames || !isSafeSyncName(name)) return@forEach
      val childRelativePath = if (root) name else childRelativePath(relativePath, name)
      if (shouldSyncRelativePath(childRelativePath, child.isDirectory, recordsOnly) ||
        isObsoleteLocalOnlySyncPath(childRelativePath)) {
        ensureSyncActive(request)
        deleteManagedDocumentEntry(child, childRelativePath, recordsOnly, request, stats)
      }
    }
  }

  private fun copyFileToDocument(
    source: File,
    target: DocumentFile,
    existing: DocumentFile?,
    relativePath: String,
    request: SyncRequest,
    stats: AndroidSyncStats
  ) {
    ensureSyncActive(request)
    if (existing != null && !existing.isFile) {
      error("Cannot export file over folder ${source.name}.")
    }
    val existingDigest = ensureRemoteFileUnchanged(relativePath, existing, stats)
    if (existing != null && shouldSkipDocumentExport(source, existing, existingDigest)) return
    val tempName = "${source.name}.tmp"
    val staleTemp = target.findFile(tempName)
    if (staleTemp != null && !staleTemp.delete()) {
      error("Cannot clean stale temp file $tempName.")
    } else if (staleTemp != null) {
      stats.staleTempDeletedCount += 1
    }
    val temp = target.createFile(mimeFor(source.name), tempName)
      ?: error("Cannot create $tempName.")
    var replacing = false
    try {
      val expectedLength = source.length()
      ensureSyncActive(request)
      contentResolver.openOutputStream(temp.uri, "wt")?.use { output ->
        source.inputStream().use { input ->
          val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
          var copied = 0L
          while (true) {
            ensureSyncActive(request)
            val count = input.read(buffer)
            if (count < 0) break
            output.write(buffer, 0, count)
            copied += count
          }
          output.flush()
          if (expectedLength >= 0L && copied != expectedLength) {
            error("Incomplete export for ${source.name}.")
          }
        }
      } ?: error("Cannot write $tempName.")
      val tempLength = temp.length()
      if (expectedLength >= 0L && tempLength > 0L && tempLength != expectedLength) {
        error("Incomplete exported temp for ${source.name}.")
      }
      ensureSyncActive(request)
      val current = target.findFile(source.name)
      ensureRemoteFileUnchanged(relativePath, current, stats)
      replaceDocumentWithTemp(
        temp,
        current,
        source.name,
        stats.remoteFileDigest(relativePath)
      )
      replacing = true
      stats.exportedFileCount += 1
    } catch (error: Throwable) {
      if (!replacing) temp.delete()
      throw error
    }
  }

  private fun shouldSkipDocumentExport(source: File, existing: DocumentFile, existingDigest: ByteArray?): Boolean {
    val expectedLength = source.length()
    val existingLength = existing.length()
    if (expectedLength == 0L && existingLength == 0L) return true
    if (expectedLength > 0L && existingLength > 0L && expectedLength != existingLength) return false
    if (existingDigest == null) return false
    return source.inputStream().use { streamDigest(it).contentEquals(existingDigest) }
  }

  private fun ensureRemoteFileUnchanged(
    relativePath: String,
    existing: DocumentFile?,
    stats: AndroidSyncStats
  ): ByteArray? {
    val expectedDigest = stats.remoteFileDigest(relativePath)
    if (existing == null) {
      if (expectedDigest != null) error("Sync folder entry was removed while syncing: $relativePath")
      return null
    }
    if (expectedDigest == null) error("Sync folder changed while syncing: $relativePath")
    val actualDigest = contentResolver.openInputStream(existing.uri)?.use { input -> streamDigest(input) }
      ?: error("Cannot verify current sync file $relativePath.")
    if (!actualDigest.contentEquals(expectedDigest)) {
      error("Sync folder changed while syncing: $relativePath")
    }
    return actualDigest
  }

  private fun deleteManagedDocumentEntry(
    entry: DocumentFile,
    relativePath: String,
    recordsOnly: Boolean,
    request: SyncRequest,
    stats: AndroidSyncStats
  ) {
    ensureSyncActive(request)
    if (entry.isFile) {
      ensureRemoteFileUnchanged(relativePath, entry, stats)
      if (!entry.delete()) error("Cannot remove synchronized tombstone $relativePath.")
      stats.deletedRemoteEntryCount += 1
      return
    }
    if (!entry.isDirectory) return
    if (!stats.wasRemoteDirectory(relativePath)) {
      error("Sync folder changed while syncing: $relativePath")
    }
    entry.listFiles().forEach { child ->
      val name = child.name ?: return@forEach
      if (!isSafeSyncName(name)) return@forEach
      val childPath = childRelativePath(relativePath, name)
      if (shouldSyncRelativePath(childPath, child.isDirectory, recordsOnly) ||
        isObsoleteLocalOnlySyncPath(childPath)) {
        deleteManagedDocumentEntry(child, childPath, recordsOnly, request, stats)
      }
    }
    if (entry.listFiles().isEmpty()) {
      if (!entry.delete()) error("Cannot remove synchronized tombstone $relativePath.")
      stats.deletedRemoteEntryCount += 1
    }
  }

  private fun streamDigest(input: java.io.InputStream): ByteArray {
    val digest = java.security.MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
    while (true) {
      val read = input.read(buffer)
      if (read < 0) break
      if (read > 0) digest.update(buffer, 0, read)
    }
    return digest.digest()
  }

  private fun replaceDocumentWithTemp(
    temp: DocumentFile,
    existing: DocumentFile?,
    finalName: String,
    expectedDigest: ByteArray?
  ) {
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
      if (expectedDigest == null) {
        error("Sync folder changed while syncing: $finalName")
      }
      val backupDigest = contentResolver.openInputStream(existing.uri)
        ?.use { input -> streamDigest(input) }
        ?: error("Cannot verify SAF sync backup: $finalName")
      if (!backupDigest.contentEquals(expectedDigest)) {
        error("Sync folder changed while syncing: $finalName")
      }
      if (!temp.renameTo(finalName)) {
        error("Cannot finalize $finalName.")
      }
      if (!runCatching { existing.delete() }.getOrDefault(false)) {
        Log.w("WordHunter", "Could not delete SAF sync backup: $backupName")
      }
    } catch (error: Throwable) {
      if (!existing.renameTo(finalName)) {
        Log.w("WordHunter", "Could not restore SAF sync backup: $backupName")
      }
      throw error
    }
  }

  private fun copyDocumentFileToFile(
    source: DocumentFile,
    destination: File,
    relativePath: String,
    request: SyncRequest,
    stats: AndroidSyncStats
  ) {
    ensureSyncActive(request)
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
      if (expectedLength > 0L) stats.ensureCanStage(relativePath, expectedLength)
      ensureSyncActive(request)
      contentResolver.openInputStream(source.uri)?.use { input ->
        FileOutputStream(temp).use { output ->
          val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
          val digest = java.security.MessageDigest.getInstance("SHA-256")
          var copied = 0L
          while (true) {
            ensureSyncActive(request)
            val read = input.read(buffer)
            if (read < 0) break
            if (read == 0) continue
            copied += read
            stats.ensureCanStage(relativePath, copied)
            output.write(buffer, 0, read)
            digest.update(buffer, 0, read)
          }
          if (expectedLength > 0L && copied != expectedLength) {
            error("Incomplete import for ${destination.name}.")
          }
          stats.recordStagedFile(relativePath, copied, digest.digest())
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
      if (temp.renameTo(destination)) {
        stats.importedFileCount += 1
        return
      }
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
        stats.importedFileCount += 1
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

  private fun inventoryObsoleteDocumentTree(
    entry: DocumentFile,
    relativePath: String,
    request: SyncRequest,
    stats: AndroidSyncStats,
    depth: Int
  ) {
    ensureSyncActive(request)
    if (depth > ANDROID_SYNC_MAX_DEPTH) {
      error("Android sync folder nesting is too deep (max $ANDROID_SYNC_MAX_DEPTH): $relativePath")
    }
    if (entry.isDirectory) {
      stats.recordRemoteDirectory(relativePath)
      entry.listFiles().forEach { child ->
        val name = child.name ?: return@forEach
        if (!isSafeSyncName(name)) return@forEach
        val childPath = childRelativePath(relativePath, name)
        stats.visitRemote(childPath)
        inventoryObsoleteDocumentTree(child, childPath, request, stats, depth + 1)
      }
      return
    }
    if (!entry.isFile) return
    val digest = java.security.MessageDigest.getInstance("SHA-256")
    var bytes = 0L
    contentResolver.openInputStream(entry.uri)?.use { input ->
      val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
      while (true) {
        ensureSyncActive(request)
        val read = input.read(buffer)
        if (read < 0) break
        if (read == 0) continue
        bytes += read
        stats.ensureCanStage(relativePath, bytes)
        digest.update(buffer, 0, read)
      }
    } ?: error("Cannot inspect obsolete sync file $relativePath.")
    stats.recordStagedFile(relativePath, bytes, digest.digest())
  }

  private fun validateLocalExportTree(
    source: File,
    stats: AndroidSyncStats,
    root: Boolean = false,
    relativePath: String = "",
    depth: Int = 0
  ) {
    if (depth > ANDROID_SYNC_MAX_DEPTH) {
      error("Local sync data nesting is too deep (max $ANDROID_SYNC_MAX_DEPTH): $relativePath")
    }
    val children = source.listFiles() ?: error("Cannot list local sync staging path $relativePath.")
    children.forEach { child ->
      if (!isSafeSyncName(child.name)) return@forEach
      val childPath = if (root) child.name else childRelativePath(relativePath, child.name)
      if (!shouldSyncRelativePath(childPath, child.isDirectory, recordsOnly = false)) return@forEach
      stats.visitLocal(childPath, if (child.isFile) child.length() else null)
      if (child.isDirectory) {
        validateLocalExportTree(child, stats, relativePath = childPath, depth = depth + 1)
      }
    }
  }

  private fun childRelativePath(parent: String, child: String): String {
    return if (parent.isBlank()) child else "$parent/$child"
  }

  private fun shouldSyncRelativePath(relativePath: String, isDirectory: Boolean, recordsOnly: Boolean): Boolean {
    val rootName = relativePath.substringBefore("/")
    if (recordsOnly && rootName !in recordDataNames) return false
    if (rootName !in knownDataNames) return false
    val name = relativePath.substringAfterLast("/")
    if (!isSafeSyncName(name)) return false
    if (!isDirectory && rootName == "books" && name in skippedBookRecordNames) return false
    if (rootName == "records") {
      val inRecordsV1 = relativePath == "records/v1" || relativePath.startsWith("records/v1/")
      val recordKind = relativePath.split("/").getOrNull(2)
      if (recordKind != null && recordKind !in syncRecordDirectoryNames) return false
      return if (isDirectory) {
        relativePath == "records" || inRecordsV1
      } else {
        inRecordsV1 && isSyncRecordName(name)
      }
    }
    return true
  }

  private fun isObsoleteLocalOnlySyncPath(relativePath: String): Boolean {
    return relativePath == "records/v1/prefs" || relativePath.startsWith("records/v1/prefs/")
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

  private fun isIncompleteLocalRecordFile(source: File, stats: AndroidSyncStats): Boolean {
    if (!isSyncRecordFile(source) || source.length() != 0L) return false
    Log.w("WordHunter", "Skipping empty local sync record: ${source.name}")
    stats.incompleteLocalRecordCount += 1
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

  private fun stagingHealth(
    stagingRoot: File,
    incomingDir: File,
    status: String,
    stats: AndroidSyncStats,
    backend: JSONObject? = null,
    lastError: String? = null
  ): JSONObject {
    return JSONObject()
      .put("status", status)
      .put("rootExists", stagingRoot.exists())
      .put("incomingExists", incomingDir.exists())
      .put("incomingReadable", incomingDir.canRead())
      .put("incomingWritable", incomingDir.canWrite())
      .put("stats", stats.toJson())
      .put("backend", backend ?: JSONObject.NULL)
      .put("lastError", lastError ?: JSONObject.NULL)
  }

  private fun syncHealthEnvelope(
    status: String,
    saf: JSONObject?,
    staging: JSONObject?,
    backend: JSONObject?,
    lastError: String? = null
  ): JSONObject {
    return JSONObject()
      .put("status", status)
      .put("saf", saf ?: JSONObject.NULL)
      .put("staging", staging ?: JSONObject.NULL)
      .put("backend", backend ?: JSONObject.NULL)
      .put("lastError", lastError ?: JSONObject.NULL)
  }

  private fun completeSyncRequest(
    request: SyncRequest,
    success: Boolean,
    path: String?,
    error: String?,
    cancelled: Boolean,
    status: String,
    health: JSONObject
  ) {
    val shouldDispatch = synchronized(syncLock) {
      if (activeSyncRequest?.id != request.id) {
        false
      } else {
        activeSyncRequest = null
        if (pendingSyncRequestId == request.id) pendingSyncRequestId = null
        true
      }
    }
    if (!shouldDispatch) {
      Log.w("WordHunter", "Ignoring late Android sync result for request ${request.id}.")
      return
    }
    request.timeoutRunnable?.let { mainHandler.removeCallbacks(it) }
    val detail = JSONObject()
      .put("requestId", request.id)
      .put("success", success)
      .put("path", path ?: JSONObject.NULL)
      .put("error", error ?: JSONObject.NULL)
      .put("cancelled", cancelled)
      .put("status", status)
      .put("terminal", true)
      .put("health", health)
    dispatchAndroidSyncDetail(detail, terminal = true)
  }

  private fun dispatchAndroidSyncProgress(request: SyncRequest, status: String, health: JSONObject? = null, path: String? = null) {
    if (!isSyncRequestActive(request)) return
    request.timeoutRunnable?.let {
      mainHandler.removeCallbacks(it)
      mainHandler.postDelayed(it, ANDROID_SYNC_TIMEOUT_MS)
    }
    val detail = JSONObject()
      .put("requestId", request.id)
      .put("success", false)
      .put("path", path ?: JSONObject.NULL)
      .put("error", JSONObject.NULL)
      .put("cancelled", false)
      .put("status", status)
      .put("terminal", false)
      .put("health", health ?: syncHealthEnvelope(status, saf = null, staging = null, backend = null))
    dispatchAndroidSyncDetail(detail, terminal = false)
  }

  private fun dispatchAndroidSyncDetail(detail: JSONObject, terminal: Boolean) {
    if (terminal) pendingSyncResult = detail
    val script = "window.dispatchEvent(new CustomEvent('wordhunter:android-sync-folder',{detail:$detail}));"
    appWebView?.post {
      appWebView?.postDelayed({
        appWebView?.evaluateJavascript(script, null)
        if (terminal && pendingSyncResult === detail) pendingSyncResult = null
      }, 250)
    }
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

  private fun normalizeBridgeRequestId(value: String?, prefix: String): String {
    val raw = value
      ?.trim()
      ?.takeIf { it.isNotEmpty() }
      ?: "$prefix-${bridgeRequestCounter.incrementAndGet()}"
    return raw
      .replace(Regex("[^A-Za-z0-9._:-]"), "_")
      .take(96)
      .ifBlank { "$prefix-${bridgeRequestCounter.incrementAndGet()}" }
  }

  private fun createExportDocumentIntent(filename: String, mime: String): Intent {
    return Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = mime
      putExtra(Intent.EXTRA_TITLE, filename)
    }
  }

  private fun writeExportDocument(uri: Uri, data: String) {
    contentResolver.openFileDescriptor(uri, "wt")?.use { descriptor ->
      FileOutputStream(descriptor.fileDescriptor).use { output ->
        val writer = OutputStreamWriter(output, Charsets.UTF_8)
        writer.write(data)
        writer.flush()
        output.fd.sync()
      }
    } ?: error("Cannot open export document.")
  }

  private fun dispatchAndroidExportResult(
    requestId: String,
    success: Boolean,
    error: String?,
    cancelled: Boolean,
    status: String
  ) {
    val detail = JSONObject()
      .put("requestId", requestId)
      .put("success", success)
      .put("error", error ?: JSONObject.NULL)
      .put("cancelled", cancelled)
      .put("status", status)
      .put("terminal", true)
    pendingExportResult = detail
    val script = "window.dispatchEvent(new CustomEvent('wordhunter:android-export',{detail:$detail}));"
    appWebView?.post {
      appWebView?.postDelayed({
        appWebView?.evaluateJavascript(script, null)
        if (pendingExportResult === detail) pendingExportResult = null
      }, 250)
    }
  }

  private fun dispatchAndroidExportProgress(requestId: String, status: String) {
    val detail = JSONObject()
      .put("requestId", requestId)
      .put("success", false)
      .put("error", JSONObject.NULL)
      .put("cancelled", false)
      .put("status", status)
      .put("terminal", false)
    val script = "window.dispatchEvent(new CustomEvent('wordhunter:android-export',{detail:$detail}));"
    appWebView?.post { appWebView?.evaluateJavascript(script, null) }
  }

  private fun dispatchPendingAndroidExportResult() {
    val detail = pendingExportResult ?: return
    val script = "window.dispatchEvent(new CustomEvent('wordhunter:android-export',{detail:$detail}));"
    appWebView?.post {
      appWebView?.postDelayed({
        appWebView?.evaluateJavascript(script, null)
        if (pendingExportResult === detail) pendingExportResult = null
      }, 250)
    }
  }

  private fun safeExportFilename(value: String?): String {
    val name = value
      ?.trim()
      ?.replace(Regex("[\\\\/\\p{Cntrl}]+"), "-")
      ?.take(120)
      ?.takeIf { it.isNotEmpty() }
      ?: "wordhunter-export.json"
    return if (name == "." || name == "..") "wordhunter-export.json" else name
  }

  private fun safeMimeType(value: String?): String {
    val mime = value?.trim()?.takeIf { it.contains("/") && !it.contains("\n") }
    return mime ?: "application/octet-stream"
  }

  private fun showTtsNotification() {
    runOnUiThread {
      if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
        if (!ttsNotificationPermissionRequested && !isFinishing && !isDestroyed) {
          ttsNotificationPermissionRequested = true
          runCatching { ttsNotificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS) }
            .onFailure { Log.w("WordHunter", "Cannot request TTS notification permission.", it) }
        }
        return@runOnUiThread
      }

      val manager = getSystemService(NotificationManager::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        manager.createNotificationChannel(
          NotificationChannel(TTS_NOTIFICATION_CHANNEL_ID, "TTS", NotificationManager.IMPORTANCE_LOW).apply {
            setShowBadge(false)
          }
        )
      }
      val openApp = Intent(this, MainActivity::class.java).apply {
        addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      }
      val contentIntent = PendingIntent.getActivity(
        this,
        0,
        openApp,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
      val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(this, TTS_NOTIFICATION_CHANNEL_ID)
      } else {
        Notification.Builder(this)
      }
      manager.notify(
        TTS_NOTIFICATION_ID,
        builder
          .setSmallIcon(android.R.drawable.ic_media_play)
          .setContentTitle(applicationInfo.loadLabel(packageManager))
          .setContentText("TTS")
          .setContentIntent(contentIntent)
          .setAutoCancel(true)
          .setOnlyAlertOnce(true)
          .setCategory(Notification.CATEGORY_TRANSPORT)
          .setVisibility(Notification.VISIBILITY_PRIVATE)
          .build()
      )
    }
  }

  private fun hideTtsNotification() {
    runOnUiThread {
      getSystemService(NotificationManager::class.java).cancel(TTS_NOTIFICATION_ID)
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
