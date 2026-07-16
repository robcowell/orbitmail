package orbit.mail

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import orbit.auth.OAuthProviderConfig
import orbit.data.Provider
import java.util.UUID

/**
 * First-run onboarding: sign in to add the first account. Each configured
 * provider launches AppAuth's Custom-Tab consent via an ActivityResult contract;
 * on return [AppGraph.completeSignIn] exchanges the code, creates the account,
 * and runs the first sync — after which [accountsSnapshot] flips the app to the
 * inbox. Providers with no build-time client id are hidden.
 */
@Composable
fun AddAccountScreen(graph: AppGraph, modifier: Modifier = Modifier) {
    val scope = rememberCoroutineScope()
    val google = remember { graph.googleConfig() }
    val microsoft = remember { graph.microsoftConfig() }

    // The provider + generated account id for the in-flight sign-in, so the
    // ActivityResult callback can complete it.
    var pending by remember { mutableStateOf<Pending?>(null) }
    var status by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val data = result.data
        val p = pending
        pending = null
        if (data == null || p == null) {
            busy = false
            status = "Sign-in cancelled."
            return@rememberLauncherForActivityResult
        }
        scope.launch {
            try {
                graph.completeSignIn(p.config, p.accountId, p.provider, data)
                // accountsSnapshot now emits the new account → the app leaves this screen.
            } catch (e: Exception) {
                busy = false
                status = "Sign-in failed: ${e.message ?: "unknown error"}"
            }
        }
    }

    fun startSignIn(config: OAuthProviderConfig, provider: Provider) {
        busy = true
        status = "Opening sign-in…"
        pending = Pending(config, UUID.randomUUID().toString(), provider)
        launcher.launch(graph.authorizationIntent(config))
    }

    Column(
        modifier = modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("Orbit Mail", style = MaterialTheme.typography.headlineMedium)
        Text(
            "Add an account to get started",
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(top = 8.dp, bottom = 24.dp),
        )

        if (busy) {
            CircularProgressIndicator()
        } else {
            if (google != null) {
                Button(onClick = { startSignIn(google, Provider.GMAIL) }, modifier = Modifier.widthIn(min = 220.dp)) {
                    Text("Sign in with Google")
                }
            }
            if (microsoft != null) {
                Button(
                    onClick = { startSignIn(microsoft, Provider.O365) },
                    modifier = Modifier.padding(top = 12.dp).widthIn(min = 220.dp),
                ) {
                    Text("Sign in with Microsoft")
                }
            }
            if (google == null && microsoft == null) {
                Text(
                    "No OAuth providers are configured for this build. " +
                        "Add GOOGLE_CLIENT_ID / MICROSOFT_CLIENT_ID and a redirect scheme " +
                        "(see auth/OAUTH_SETUP.md), then rebuild.",
                    style = MaterialTheme.typography.bodySmall,
                    textAlign = TextAlign.Center,
                )
            }
        }

        status?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 20.dp), textAlign = TextAlign.Center)
        }
    }
}

private data class Pending(val config: OAuthProviderConfig, val accountId: String, val provider: Provider)
