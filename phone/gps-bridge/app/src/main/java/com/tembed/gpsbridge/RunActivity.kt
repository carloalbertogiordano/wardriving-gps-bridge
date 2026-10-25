package com.tembed.gpsbridge

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.File

/**
 * One saved run: the networks on an OpenStreetMap map (Leaflet bundled in the
 * app, tiles from OSM), centered on the first network discovered, plus the
 * actions that get the file to Wigle: share, save, delete.
 */
class RunActivity : Activity() {

    companion object {
        const val EXTRA_NAME = "name"
        private const val REQUEST_SAVE = 200
        private const val WIGLE_UPLOAD_URL = "https://wigle.net/uploads"
        private const val USER_AGENT =
            "WardrivingGPSBridge/0.1 (+https://github.com/carloalbertogiordano/wardriving-gps-bridge)"
    }

    private lateinit var file: File
    private lateinit var mapView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_run)

        // Only a bare file name is accepted, then resolved inside the runs
        // folder: nothing outside it can be opened through this screen.
        val name = File(intent.getStringExtra(EXTRA_NAME) ?: "").name
        file = File(RunFiles.dir(this), name)
        if (!file.isFile) {
            finish()
            return
        }

        val summary = RunFiles.summary(file)
        title = RunFiles.title(summary)
        findViewById<TextView>(R.id.runInfo).text = "${summary.networks} networks"

        findViewById<Button>(R.id.shareButton).setOnClickListener { share() }
        findViewById<Button>(R.id.saveButton).setOnClickListener { save() }
        findViewById<Button>(R.id.wigleButton).setOnClickListener { open(WIGLE_UPLOAD_URL) }
        findViewById<Button>(R.id.deleteButton).setOnClickListener { confirmDelete() }

        mapView = findViewById(R.id.mapView)
        setupMap()
    }

    override fun onDestroy() {
        if (::mapView.isInitialized) mapView.destroy()
        super.onDestroy()
    }

    private fun setupMap() {
        mapView.settings.javaScriptEnabled = true
        // OSM's tile policy asks clients to identify themselves.
        mapView.settings.userAgentString = USER_AGENT
        mapView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                // Parsing off the main thread: a long run has thousands of rows.
                Thread {
                    val json = RunFiles.pointsJson(RunFiles.points(file))
                    runOnUiThread { mapView.evaluateJavascript("showPoints($json)", null) }
                }.start()
            }

            // Links on the map (the OSM attribution) go to the browser; the
            // map page itself must never be navigated away.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                open(request.url.toString())
                return true
            }
        }
        mapView.loadUrl("file:///android_asset/map.html")
    }

    private fun share() {
        val uri = FileProvider.getUriForFile(this, "$packageName.files", file)
        val send = Intent(Intent.ACTION_SEND)
            .setType("text/csv")
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        startActivity(Intent.createChooser(send, "Share run"))
    }

    // The system file picker lets the user drop the file in Downloads (or any
    // folder), from where Wigle's upload page can pick it up.
    private fun save() {
        val create = Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("text/csv")
            .putExtra(Intent.EXTRA_TITLE, file.name)
        startActivityForResult(create, REQUEST_SAVE)
    }

    @Deprecated("Deprecated in API 30, still the simplest way for a plain Activity")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        val target = data?.data
        if (requestCode != REQUEST_SAVE || resultCode != RESULT_OK || target == null) return
        try {
            contentResolver.openOutputStream(target)?.use { out -> file.inputStream().use { it.copyTo(out) } }
            Toast.makeText(this, "Saved", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(this, "Could not save the file", Toast.LENGTH_LONG).show()
        }
    }

    private fun open(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, "No app can open this link", Toast.LENGTH_SHORT).show()
        }
    }

    private fun confirmDelete() {
        AlertDialog.Builder(this)
            .setTitle("Delete this run?")
            .setMessage("The file cannot be recovered. Share or save it first if you need it.")
            .setPositiveButton("Delete") { _, _ ->
                file.delete()
                finish()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }
}
