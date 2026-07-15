package orbit.ui.compose

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

/** Composer: To/Cc/Subject/Body + Send. Seeded from a reply/forward draft. */
@Composable
fun ComposeScreen(vm: ComposeViewModel, accountId: String, onSent: () -> Unit) {
    val state by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(state.sent) { if (state.sent) onSent() }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        val d = state.draft
        OutlinedTextField(d.to, { v -> vm.update { it.copy(to = v) } }, label = { Text("To") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(d.cc, { v -> vm.update { it.copy(cc = v) } }, label = { Text("Cc") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(d.subject, { v -> vm.update { it.copy(subject = v) } }, label = { Text("Subject") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(d.bodyText, { v -> vm.update { it.copy(bodyText = v) } }, label = { Text("Message") }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
        // The collapsed quoted original (reply/forward) is appended on send.
        d.quotedText?.let { Text(it, Modifier.padding(top = 12.dp)) }
        state.error?.let { Text("Send failed: $it", Modifier.padding(top = 8.dp)) }
        Button(onClick = { vm.send(accountId) }, enabled = !state.sending, modifier = Modifier.padding(top = 12.dp)) {
            Text(if (state.sending) "Sending…" else "Send")
        }
    }
}
