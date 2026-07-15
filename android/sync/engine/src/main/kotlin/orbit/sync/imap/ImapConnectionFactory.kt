package orbit.sync.imap

import com.sun.mail.imap.IMAPStore
import orbit.sync.Auth
import orbit.sync.SyncAccount
import java.util.Properties
import javax.mail.Session

/**
 * Opens authenticated IMAP connections. XOAUTH2 uses the same config proven by
 * the spike (`mail.imap.auth.mechanisms=XOAUTH2`, access token as the password),
 * so the OAuth access token from Step 3 flows straight through.
 */
object ImapConnectionFactory {

    fun connect(account: SyncAccount): ImapConnection {
        val scheme = if (account.useTls) "imaps" else "imap"
        val props = Properties().apply {
            put("mail.store.protocol", scheme)
            put("mail.$scheme.host", account.host)
            put("mail.$scheme.port", account.port.toString())
            if (account.useTls) put("mail.$scheme.ssl.enable", "true")
            // Blocking folder.idle() model (spike Finding 2) — never socketchannels.
            put("mail.$scheme.usesocketchannels", "false")
            // Never mark messages \Seen just by fetching their body (BODY.PEEK).
            // Without this, sync would silently read every message, and the flag
            // reconcile pass would then pull \Seen back and zero the unread count.
            put("mail.$scheme.peek", "true")
            if (account.auth is Auth.XOAuth2) put("mail.$scheme.auth.mechanisms", "XOAUTH2")
        }
        val session = Session.getInstance(props)
        val store = session.getStore(scheme) as IMAPStore
        when (val auth = account.auth) {
            is Auth.XOAuth2 -> store.connect(account.host, auth.email, auth.accessToken)
            is Auth.Password -> store.connect(account.host, auth.username, auth.password)
        }
        return ImapConnection(store)
    }
}
