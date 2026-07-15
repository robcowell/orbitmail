package orbit.ui.compose

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import orbit.ui.ComposeDraft
import orbit.ui.MailFormat
import orbit.ui.MessageContent

/**
 * The reader shows the whole conversation stacked (received + Sent interleaved,
 * audit §Threading). Reply / Reply All / Forward build a draft via the verified
 * ReplyComposer and hand it to the composer.
 */
@Composable
fun ThreadReaderScreen(
    vm: ReaderViewModel,
    nowMs: Long,
    selfAddresses: Set<String>,
    onCompose: (ComposeDraft) -> Unit,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { vm.reply()?.let(onCompose) }) { Text("Reply") }
            OutlinedButton(onClick = { vm.replyAll(selfAddresses)?.let(onCompose) }) { Text("Reply All") }
            OutlinedButton(onClick = { vm.forward()?.let(onCompose) }) { Text("Forward") }
        }
        for (msg in state.messages) MessageCard(msg, nowMs)
    }
}

@Composable
private fun MessageCard(msg: MessageContent, nowMs: Long) {
    Card(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Column(Modifier.padding(12.dp)) {
            Row(Modifier.fillMaxWidth()) {
                Text(MailFormat.senderDisplayName(msg.from), fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                Text(MailFormat.listDate(msg.date, nowMs), style = MaterialTheme.typography.labelSmall)
            }
            Text("To: ${msg.to}", style = MaterialTheme.typography.labelSmall)
            // HTML bodies render via an AndroidView(WebView) with JS disabled +
            // sanitized HTML in the app (audit §print/security); plain text here.
            Text(msg.bodyText ?: "", Modifier.padding(top = 8.dp), style = MaterialTheme.typography.bodyMedium)
        }
    }
}
