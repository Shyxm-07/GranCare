package com.grancare.wear.data

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.Scope
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * Google authorization for the Calendar API using Google Identity Services.
 * Needs an OAuth client of type "Android" in Google Cloud for package
 * com.grancare.wear + your signing SHA-1, with the Google Calendar API enabled.
 * No client secret is stored on the watch.
 */
object Auth {
    const val CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events"

    private fun request(): AuthorizationRequest =
        AuthorizationRequest.builder().setRequestedScopes(listOf(Scope(CALENDAR_SCOPE))).build()

    sealed interface Outcome {
        data class Token(val value: String) : Outcome
        /** The user must approve access once; launch this from an Activity. */
        data class NeedsConsent(val intent: PendingIntent) : Outcome
        data class Failed(val error: Throwable?) : Outcome
    }

    /** Silent when access was granted before; returns NeedsConsent the first time. */
    suspend fun authorize(context: Context): Outcome = suspendCancellableCoroutine { cont ->
        Identity.getAuthorizationClient(context).authorize(request())
            .addOnSuccessListener { r: AuthorizationResult ->
                val pi = r.pendingIntent
                val token = r.accessToken
                cont.resume(
                    when {
                        r.hasResolution() && pi != null -> Outcome.NeedsConsent(pi)
                        token != null -> Outcome.Token(token)
                        else -> Outcome.Failed(null)
                    }
                )
            }
            .addOnFailureListener { cont.resume(Outcome.Failed(it)) }
    }

    /** Token for background work, or null if the user still has to approve access. */
    suspend fun token(context: Context): String? = (authorize(context) as? Outcome.Token)?.value

    /** Reads the result of the consent screen launched for NeedsConsent. */
    fun tokenFromConsent(context: Context, data: Intent?): String? {
        if (data == null) return null
        return runCatching { Identity.getAuthorizationClient(context).getAuthorizationResultFromIntent(data).accessToken }.getOrNull()
    }
}
