package com.tembed.gpsbridge

/**
 * Time-ordered history of recent fixes. The T-Embed has no clock comparable
 * to the phone's, so it cannot say "this scan happened at T". It says "this
 * scan happened N ms ago" and the phone looks the position up here, which
 * also lets scans that were queued while the phone was unreachable be placed
 * correctly once they are finally delivered.
 */
object FixHistory {

    // One fix per second, so this covers about two hours.
    private const val MAX_FIXES = 7200

    private val fixes = ArrayDeque<LocationService.Fix>()

    @Synchronized
    fun add(fix: LocationService.Fix) {
        fixes.addLast(fix)
        while (fixes.size > MAX_FIXES) fixes.removeFirst()
    }

    @Synchronized
    fun clear() = fixes.clear()

    /** The fix closest to [timeMillis], or null if none is within [maxGapMillis]. */
    @Synchronized
    fun nearest(timeMillis: Long, maxGapMillis: Long): LocationService.Fix? {
        var best: LocationService.Fix? = null
        var bestGap = Long.MAX_VALUE
        // Newest first: live requests ask for "now", so they hit immediately.
        for (i in fixes.indices.reversed()) {
            val gap = Math.abs(fixes[i].timeMillis - timeMillis)
            if (gap < bestGap) {
                best = fixes[i]
                bestGap = gap
            } else if (fixes[i].timeMillis < timeMillis) {
                break // moving further into the past: the gap only grows
            }
        }
        return if (bestGap <= maxGapMillis) best else null
    }
}
