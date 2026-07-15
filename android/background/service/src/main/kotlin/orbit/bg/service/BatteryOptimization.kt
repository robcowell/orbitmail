package orbit.bg.service

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings

/**
 * Battery-optimization exemption — needed to sustain IDLE in the background
 * through Doze (plan §2: "requesting battery-optimization exemption from the
 * user, with a clear explanation of why, at the point of asking"). Ask only when
 * the user enables IDLE, not at launch.
 *
 * Deferred build (Android).
 */
object BatteryOptimization {

    fun isExempt(context: Context): Boolean {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        return pm.isIgnoringBatteryOptimizations(context.packageName)
    }

    /** Intent to prompt the user for the exemption (show the rationale first). */
    @SuppressLint("BatteryLife")
    fun requestExemptionIntent(context: Context): Intent =
        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
}
