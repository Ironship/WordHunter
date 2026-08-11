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
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Base64
import android.util.Log
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStreamWriter
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

// The SAF picker may stay foreground for minutes while the user chooses a
// destination, so no export timeout is armed before the picker launch. The
// picker-phase timeout is a short grace period re-armed on every onResume.
private const val ANDROID_EXPORT_GRACE_MS = 45_000L
private const val ANDROID_EXPORT_WRITE_TIMEOUT_MS = 300000L
// An abandoned import picker must not block every later import until the
// process dies; the pending request times out natively after ~5 minutes.
private const val ANDROID_IMPORT_TIMEOUT_MS = 5 * 60 * 1000L
private const val ANDROID_TRANSFER_MAX_BYTES = 2L * 1024L * 1024L * 1024L
private const val ANDROID_PDF_MAX_BITMAP_PIXELS = 8_000_000
private const val ANDROID_DIRECT_EXPORT_MAX_CHARS = 64L * 1024L * 1024L
private const val MAX_TTS_SPEAK_CHARS = 20_000
private const val TTS_NOTIFICATION_CHANNEL_ID = "wordhunter-tts"
private const val TTS_NOTIFICATION_ID = 1001
private const val EXTRA_TTS_STOP = "wordhunter-tts-stop"

class MainActivity : TauriActivity() {
  private var appWebView: WebView? = null
  private var textToSpeech: TextToSpeech? = null
  private val exportExecutor = Executors.newSingleThreadExecutor()
  private val mainHandler = Handler(Looper.getMainLooper())
  private val bridgeLock = Any()
  private val bridgeRequestCounter = AtomicLong()
  private val pdfRenderSessions = mutableMapOf<String, PdfRenderSession>()
  private val pdfRenderLock = Any()
  private var ttsNotificationPermissionRequested = false
  @Volatile private var ttsReady = false
  @Volatile private var pendingExport: PendingExport? = null
  @Volatile private var pendingImportRequestId: String? = null
  private var pendingImportWatchdog: Runnable? = null
  private var importLaunchRequestId: String? = null
  @Volatile private var pendingExportResult: JSONObject? = null
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
      synchronized(bridgeLock) {
        if (pendingExport?.requestId == export.requestId) pendingExport = null
      }
      export.timeoutRunnable?.let { mainHandler.removeCallbacks(it) }
      export.sourcePath?.let { File(it).delete() }
      dispatchAndroidExportResult(export.requestId, success = false, error = null, cancelled = true, status = "cancelled")
      return@registerForActivityResult
    }
    val readyToWrite = synchronized(bridgeLock) {
      if (pendingExport?.requestId != export.requestId) {
        false
      } else {
        export.timeoutRunnable?.let { mainHandler.removeCallbacks(it) }
        export.awaitingPicker = false
        val writeTimeout = Runnable {
          synchronized(bridgeLock) {
            if (pendingExport?.requestId == export.requestId) pendingExport = null
          }
          export.sourcePath?.let { File(it).delete() }
          dispatchAndroidExportResult(export.requestId, success = false, error = "Android export write timed out.", cancelled = false, status = "timeout")
        }
        export.timeoutRunnable = writeTimeout
        mainHandler.postDelayed(writeTimeout, ANDROID_EXPORT_WRITE_TIMEOUT_MS)
        true
      }
    }
    if (!readyToWrite) return@registerForActivityResult
    dispatchAndroidExportProgress(export.requestId, "writing")
    exportExecutor.execute {
      val outcome = runCatching {
        export.sourcePath?.let { writeExportFile(uri, it) }
          ?: writeExportDocument(uri, export.data ?: "")
      }
      val stillActive = synchronized(bridgeLock) {
        if (pendingExport?.requestId != export.requestId) false
        else {
          pendingExport = null
          true
        }
      }
      if (stillActive) {
        export.timeoutRunnable?.let { mainHandler.removeCallbacks(it) }
        export.sourcePath?.let { File(it).delete() }
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
  private val importDocumentLauncher = registerForActivityResult(
    ActivityResultContracts.StartActivityForResult()
  ) { result ->
    val requestId = importLaunchRequestId ?: return@registerForActivityResult
    importLaunchRequestId = null
    val uri = result.data?.data
    if (result.resultCode != Activity.RESULT_OK || uri == null) {
      clearPendingImportIfCurrent(requestId)
      dispatchAndroidImportResult(requestId, success = false, path = null, error = null, cancelled = true)
      return@registerForActivityResult
    }
    // A result from a superseded or timed-out picker must not be processed
    // against a newer request (or none at all).
    val stillCurrent = synchronized(bridgeLock) { pendingImportRequestId == requestId }
    if (!stillCurrent) {
      Log.w("WordHunter", "Ignoring stale Android import result for $requestId.")
      return@registerForActivityResult
    }
    exportExecutor.execute {
      runCatching { copyImportDocument(uri, requestId) }
        .onSuccess { path ->
          clearPendingImportIfCurrent(requestId)
          dispatchAndroidImportResult(requestId, success = true, path = path, error = null, cancelled = false)
        }
        .onFailure { error ->
          clearPendingImportIfCurrent(requestId)
          dispatchAndroidImportResult(requestId, success = false, path = null, error = error.message, cancelled = false)
        }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    cleanTransferCache()
    cleanPdfRenderCache()
    textToSpeech = TextToSpeech(this) { status ->
      ttsReady = status == TextToSpeech.SUCCESS
    }
    textToSpeech?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
      override fun onStart(utteranceId: String?) {
        showTtsNotification()
      }

      override fun onDone(utteranceId: String?) {
        dispatchAndroidTtsResult(utteranceId, "done")
        maybeClearTtsSessionUi()
      }

      @Deprecated("Deprecated in Android API")
      override fun onError(utteranceId: String?) {
        dispatchAndroidTtsResult(utteranceId, "error")
        maybeClearTtsSessionUi()
      }

      override fun onStop(utteranceId: String?, interrupted: Boolean) {
        dispatchAndroidTtsResult(utteranceId, "stopped")
        maybeClearTtsSessionUi()
      }

      override fun onRangeStart(utteranceId: String?, start: Int, end: Int, frame: Int) {
        dispatchAndroidTtsResult(utteranceId, "range", start, end)
      }
    })
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    if (!intent.getBooleanExtra(EXTRA_TTS_STOP, false)) return
    intent.removeExtra(EXTRA_TTS_STOP)
    runOnUiThread {
      textToSpeech?.stop()
      hideTtsNotification()
      clearKeepScreenOn()
    }
    val script = "window.dispatchEvent(new CustomEvent('wordhunter:android-tts-stop'));"
    postToWebView(script)
  }

  private fun maybeClearTtsSessionUi() {
    // The last utterance of a chain drains the queue; release the
    // notification and FLAG_KEEP_SCREEN_ON so a single spoken word does not
    // leave them stuck.
    if (textToSpeech?.isSpeaking == false) {
      hideTtsNotification()
      clearKeepScreenOn()
    }
  }

  private fun cleanTransferCache() {
    val root = File(cacheDir, "wordhunter-transfer")
    val children = root.listFiles() ?: return
    val cutoff = System.currentTimeMillis() - 6 * 60 * 60 * 1000L
    for (file in children) {
      if (file.isFile && file.lastModified() < cutoff) {
        if (!file.delete()) {
          Log.w("WordHunter", "Could not clean stale transfer cache: ${file.absolutePath}")
        }
      }
    }
  }

  private fun cleanPdfRenderCache() {
    val root = cacheDir
    val stale = root.listFiles { file -> file.isFile && file.name.startsWith("wordhunter-pdf-render-") }
      ?: return
    for (file in stale) {
      if (!file.delete()) {
        Log.w("WordHunter", "Could not clean stale PDF render cache: ${file.absolutePath}")
      }
    }
  }

  private fun keepScreenOn() {
    runOnUiThread { window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
  }

  private fun clearKeepScreenOn() {
    runOnUiThread { window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
  }

  override fun onPause() {
    super.onPause()
    // The SAF picker is foreground while we are paused; the export timeout
    // must not fire while the user is still choosing a destination.
    synchronized(bridgeLock) {
      val export = pendingExport
      if (export != null && export.awaitingPicker) {
        export.timeoutRunnable?.let { mainHandler.removeCallbacks(it) }
      }
    }
  }

  override fun onResume() {
    super.onResume()
    // Re-arm a short grace period for an export that still awaits its pick:
    // the launcher result removes it once the user chooses, or it clears the
    // stale request if the dialog was abandoned.
    synchronized(bridgeLock) {
      val export = pendingExport
      if (export != null && export.awaitingPicker) {
        export.timeoutRunnable?.let { mainHandler.removeCallbacks(it) }
        val grace = Runnable {
          synchronized(bridgeLock) {
            if (pendingExport?.requestId == export.requestId) pendingExport = null
          }
          export.sourcePath?.let { File(it).delete() }
          dispatchAndroidExportResult(export.requestId, success = false, error = "Android export timed out.", cancelled = false, status = "timeout")
        }
        export.timeoutRunnable = grace
        mainHandler.postDelayed(grace, ANDROID_EXPORT_GRACE_MS)
      }
    }
    dispatchPendingAndroidExportResult()
  }

  override fun onWebViewCreate(webView: WebView) {
    appWebView = webView
    webView.isVerticalScrollBarEnabled = false
    webView.isHorizontalScrollBarEnabled = false
    webView.overScrollMode = android.view.View.OVER_SCROLL_NEVER
    webView.addJavascriptInterface(AndroidBridge(), "WordHunterAndroid")
    Log.i("WordHunter", "WebView created; parent=${webView.parent != null}")
    if (webView.parent == null) {
      setContentView(webView)
    }
  }

  override fun onDestroy() {
    synchronized(bridgeLock) {
      pendingExport?.timeoutRunnable?.let { mainHandler.removeCallbacks(it) }
      pendingExport?.sourcePath?.let { File(it).delete() }
      pendingExport = null
      pendingImportRequestId = null
      pendingImportWatchdog?.let { mainHandler.removeCallbacks(it) }
      pendingImportWatchdog = null
    }
    // Drain in-flight writes instead of interrupting them: an interrupt
    // would abort a mid-write export and leave a partial file behind.
    exportExecutor.shutdown()
    runCatching { exportExecutor.awaitTermination(3, TimeUnit.SECONDS) }
    closeAllPdfRenderSessions()
    hideTtsNotification()
    clearKeepScreenOn()
    textToSpeech?.stop()
    textToSpeech?.shutdown()
    textToSpeech = null
    super.onDestroy()
  }

  inner class AndroidBridge {
    @JavascriptInterface
    fun saveExport(data: String?, filename: String?, mime: String?, requestId: String?): Boolean {
      val payload = data ?: return false
      return queueExport(payload, null, filename, mime, requestId)
    }

    @JavascriptInterface
    fun saveExportFile(path: String?, filename: String?, mime: String?, requestId: String?): Boolean {
      val source = path?.let(::File) ?: return false
      val root = File(cacheDir, "wordhunter-transfer").canonicalFile
      val canonical = runCatching { source.canonicalFile }.getOrNull() ?: return false
      if (!canonical.isFile || !canonical.path.startsWith(root.path + File.separator)) return false
      return queueExport(null, canonical.path, filename, mime, requestId)
    }

    @JavascriptInterface
    fun chooseImportPackage(requestId: String?): Boolean {
      val id = normalizeBridgeRequestId(requestId, "android-import")
      val supersededId = synchronized(bridgeLock) {
        pendingImportWatchdog?.let { mainHandler.removeCallbacks(it) }
        pendingImportWatchdog = null
        val previous = pendingImportRequestId
        pendingImportRequestId = id
        previous
      }
      if (supersededId != null) {
        Log.w("WordHunter", "Superseding stale Android import request $supersededId.")
        dispatchAndroidImportResult(supersededId, success = false, path = null, error = "Android import superseded.", cancelled = true)
      }
      // An abandoned picker must not block imports until the process dies:
      // the pending request times out natively after ~5 minutes.
      val watchdog = Runnable {
        synchronized(bridgeLock) {
          if (pendingImportRequestId == id) {
            pendingImportRequestId = null
            pendingImportWatchdog = null
          }
        }
        dispatchAndroidImportResult(id, success = false, path = null, error = "Android import timed out.", cancelled = false)
      }
      synchronized(bridgeLock) { pendingImportWatchdog = watchdog }
      mainHandler.postDelayed(watchdog, ANDROID_IMPORT_TIMEOUT_MS)
      importLaunchRequestId = id
      runOnUiThread {
        runCatching { importDocumentLauncher.launch(createImportDocumentIntent()) }
          .onFailure { error ->
            clearPendingImportIfCurrent(id)
            dispatchAndroidImportResult(id, success = false, path = null, error = error.message, cancelled = false)
          }
      }
      return true
    }

    @JavascriptInterface
    fun speak(text: String?, lang: String?, rate: Double, utteranceId: String?): Boolean {
      val engine = textToSpeech ?: return false
      val phrase = text?.trim()?.takeIf { it.isNotEmpty() } ?: return false
      if (!ttsReady) return false
      // Guard against arbitrary JS allocating unbounded TTS buffers through the
      // bridge (the frontend splits segments at 500 chars anyway).
      if (phrase.length > MAX_TTS_SPEAK_CHARS) return false
      val result = engine.setLanguage(localeFor(lang ?: "en"))
      if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
        return false
      }
      engine.setSpeechRate(rate.toFloat().coerceIn(0.5f, 2.0f))
      val started = engine.speak(
        phrase,
        TextToSpeech.QUEUE_FLUSH,
        Bundle.EMPTY,
        utteranceId ?: System.nanoTime().toString()
      ) == TextToSpeech.SUCCESS
      if (started) {
        // The bridge runs on the WebView JS thread; window flag changes
        // must happen on the UI thread.
        runOnUiThread { keepScreenOn() }
      }
      return started
    }

    @JavascriptInterface
    fun isTtsReady(): Boolean = ttsReady

    @JavascriptInterface
    fun endTtsSession() {
      runOnUiThread {
        hideTtsNotification()
        clearKeepScreenOn()
      }
    }

    @JavascriptInterface
    fun stopTts() {
      runOnUiThread {
        textToSpeech?.stop()
        hideTtsNotification()
        clearKeepScreenOn()
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
        var descriptor: ParcelFileDescriptor? = null
        try {
          FileOutputStream(file).use { output ->
            output.write(data)
            output.fd.sync()
          }
          descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
          val renderer = PdfRenderer(descriptor)
          synchronized(pdfRenderLock) {
            pdfRenderSessions.remove(id)?.close()
            pdfRenderSessions[id] = PdfRenderSession(file, descriptor, renderer)
          }
        } catch (error: Throwable) {
          descriptor?.close()
          if (!file.delete()) {
            Log.w("WordHunter", "Could not delete failed PDF render temp: ${file.absolutePath}")
          }
          throw error
        }
        val pageCount = synchronized(pdfRenderLock) {
          pdfRenderSessions[id]?.renderer?.pageCount ?: 0
        }
        JSONObject()
          .put("success", true)
          .put("pageCount", pageCount)
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
        // The whole render runs under the lock so closeAllPdfRenderSessions()
        // on destroy can never close a PdfRenderer mid-render.
        synchronized(pdfRenderLock) {
          renderPdfPageLocked(id, pageIndex, renderWidth)
        }
      }.getOrElse { error ->
        JSONObject()
          .put("success", false)
          .put("error", error.message ?: "Could not render PDF page.")
          .toString()
      }
    }

    private fun renderPdfPageLocked(id: String, pageIndex: Int, renderWidth: Int): String {
      val session = pdfRenderSessions[id] ?: error("PDF render session is not open.")
      if (pageIndex < 0 || pageIndex >= session.renderer.pageCount) {
        error("PDF page index is out of range.")
      }
      return session.renderer.openPage(pageIndex).use { page ->
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
        var payload: String
        try {
          bitmap.eraseColor(Color.WHITE)
          page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
          val bytes = ByteArrayOutputStream()
          bitmap.compress(Bitmap.CompressFormat.PNG, 100, bytes)
          payload = JSONObject()
            .put("success", true)
            .put("width", targetWidth)
            .put("height", targetHeight)
            .put("dataUrl", "data:image/png;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP))
            .toString()
        } finally {
          bitmap.recycle()
        }
        payload
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

  private fun clearPendingImportIfCurrent(requestId: String) {
    synchronized(bridgeLock) {
      if (pendingImportRequestId == requestId) {
        pendingImportRequestId = null
        pendingImportWatchdog?.let { mainHandler.removeCallbacks(it) }
        pendingImportWatchdog = null
      }
    }
  }

  private fun queueExport(
    data: String?,
    sourcePath: String?,
    filename: String?,
    mime: String?,
    requestId: String?
  ): Boolean {
    val id = normalizeBridgeRequestId(requestId, "android-export")
    synchronized(bridgeLock) {
      if (pendingExport != null) {
        dispatchAndroidExportResult(id, success = false, error = "Android export is already running.", cancelled = false, status = "busy")
        return true
      }
      // No picker timeout is armed here: the SAF picker may stay foreground
      // for minutes, and a stale timeout would silently drop the destination
      // the user just chose. The picker phase is bounded by the short grace
      // period re-armed in onResume instead.
      pendingExport = PendingExport(
        requestId = id,
        data = data,
        sourcePath = sourcePath,
        filename = safeExportFilename(filename),
        mime = safeMimeType(mime)
      )
    }
    runOnUiThread {
      runCatching {
        exportDocumentLauncher.launch(createExportDocumentIntent(safeExportFilename(filename), safeMimeType(mime)))
      }.onFailure { error ->
        synchronized(bridgeLock) {
          pendingExport?.timeoutRunnable?.let { mainHandler.removeCallbacks(it) }
          pendingExport = null
        }
        sourcePath?.let { File(it).delete() }
        dispatchAndroidExportResult(id, success = false, error = error.message, cancelled = false, status = "error")
      }
    }
    return true
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

  private data class PendingExport(
    val requestId: String,
    val data: String?,
    val sourcePath: String?,
    val filename: String,
    val mime: String,
    var timeoutRunnable: Runnable? = null,
    var awaitingPicker: Boolean = true
  )

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
    val maxEncodedLength = 400 * 1024 * 1024 * 4 / 3 + 4
    if (raw.length > maxEncodedLength) {
      error("PDF is too large for Pocket render (max 400 MB).")
    }
    val data = Base64.decode(raw, Base64.DEFAULT)
    if (data.size > 400 * 1024 * 1024) {
      error("PDF is too large for Pocket render (max 400 MB).")
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
    if (data.length > ANDROID_DIRECT_EXPORT_MAX_CHARS) {
      error("Export is too large for direct Android write.")
    }
    contentResolver.openFileDescriptor(uri, "wt")?.use { descriptor ->
      FileOutputStream(descriptor.fileDescriptor).use { output ->
        val writer = OutputStreamWriter(output, Charsets.UTF_8)
        writer.write(data)
        writer.flush()
        output.fd.sync()
      }
    } ?: error("Cannot open export document.")
  }

  private fun writeExportFile(uri: Uri, sourcePath: String) {
    val source = File(sourcePath)
    contentResolver.openFileDescriptor(uri, "wt")?.use { descriptor ->
      source.inputStream().use { input ->
        FileOutputStream(descriptor.fileDescriptor).use { output ->
          input.copyTo(output)
          output.fd.sync()
        }
      }
    } ?: error("Cannot open export document.")
  }

  private fun createImportDocumentIntent(): Intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
    addCategory(Intent.CATEGORY_OPENABLE)
    type = "application/zip"
    putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/zip", "application/octet-stream"))
  }

  private fun copyImportDocument(uri: Uri, requestId: String): String {
    val root = File(cacheDir, "wordhunter-transfer")
    if (!root.exists() && !root.mkdirs()) error("Cannot create transfer cache.")
    val target = File(root, "${normalizeBridgeRequestId(requestId, "android-import")}.zip")
    try {
      var copied = 0L
      contentResolver.openInputStream(uri)?.use { input ->
        FileOutputStream(target).use { output ->
          val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
          while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            copied += count
            if (copied > ANDROID_TRANSFER_MAX_BYTES) error("WordHunter package is too large.")
            output.write(buffer, 0, count)
          }
          output.fd.sync()
        }
      } ?: error("Cannot open import document.")
      return target.canonicalPath
    } catch (error: Throwable) {
      target.delete()
      throw error
    }
  }

  private fun postToWebView(script: String, onPosted: (() -> Unit)? = null) {
    val webView = appWebView ?: return
    if (isDestroyed || isFinishing) return
    webView.post {
      webView.evaluateJavascript(script, null)
      onPosted?.invoke()
    }
  }

  private fun dispatchAndroidImportResult(
    requestId: String,
    success: Boolean,
    path: String?,
    error: String?,
    cancelled: Boolean
  ) {
    val detail = JSONObject()
      .put("requestId", requestId)
      .put("success", success)
      .put("path", path ?: JSONObject.NULL)
      .put("error", error ?: JSONObject.NULL)
      .put("cancelled", cancelled)
    val script = "window.dispatchEvent(new CustomEvent('wordhunter:android-import',{detail:$detail}));"
    postToWebView(script)
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
    postToWebView(script) {
      if (pendingExportResult === detail) pendingExportResult = null
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
    postToWebView(script)
  }

  private fun dispatchPendingAndroidExportResult() {
    val detail = pendingExportResult ?: return
    val script = "window.dispatchEvent(new CustomEvent('wordhunter:android-export',{detail:$detail}));"
    postToWebView(script) {
      if (pendingExportResult === detail) pendingExportResult = null
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
      val stopIntent = Intent(this, MainActivity::class.java).apply {
        addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        putExtra(EXTRA_TTS_STOP, true)
      }
      val stopPendingIntent = PendingIntent.getActivity(
        this,
        1,
        stopIntent,
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
          .setOngoing(true)
          .setOnlyAlertOnce(true)
          .setCategory(Notification.CATEGORY_TRANSPORT)
          .setVisibility(Notification.VISIBILITY_PRIVATE)
          .addAction(
            Notification.Action.Builder(
              android.R.drawable.ic_media_pause,
              "Stop",
              stopPendingIntent
            ).build()
          )
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
    postToWebView(script)
  }
}
