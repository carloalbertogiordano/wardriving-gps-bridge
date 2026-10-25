package com.tembed.gpsbridge

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.text.format.Formatter
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.ListView
import android.widget.TextView

/** The saved runs, newest first. Tapping one opens it on the map. */
class RunsActivity : Activity() {

    private lateinit var list: ListView
    private lateinit var empty: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_runs)
        title = "Saved runs"
        list = findViewById(R.id.runsList)
        empty = findViewById(R.id.emptyText)
    }

    // Reloaded on every resume: a run may have been deleted from its own
    // screen, or the open run may have grown while this one was behind.
    override fun onResume() {
        super.onResume()
        // The open run is written every few seconds; make it current first.
        LocationService.runStore?.flushIfDirty()
        val runs = RunFiles.list(this)

        empty.visibility = if (runs.isEmpty()) View.VISIBLE else View.GONE
        list.adapter = object : ArrayAdapter<RunSummary>(
            this, android.R.layout.simple_list_item_2, android.R.id.text1, runs
        ) {
            override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
                val view = super.getView(position, convertView, parent)
                val run = getItem(position)!!
                view.findViewById<TextView>(android.R.id.text1).text = RunFiles.title(run)
                view.findViewById<TextView>(android.R.id.text2).text =
                    "${run.networks} networks, ${Formatter.formatShortFileSize(context, run.sizeBytes)}"
                return view
            }
        }
        list.setOnItemClickListener { _, _, position, _ ->
            startActivity(
                Intent(this, RunActivity::class.java)
                    .putExtra(RunActivity.EXTRA_NAME, runs[position].file.name)
            )
        }
    }
}
