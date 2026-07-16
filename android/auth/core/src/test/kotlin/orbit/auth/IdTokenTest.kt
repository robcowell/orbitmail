package orbit.auth

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import java.util.Base64

class IdTokenTest {

    private fun jwt(payloadJson: String): String {
        val enc = Base64.getUrlEncoder().withoutPadding()
        val header = enc.encodeToString("""{"alg":"none"}""".toByteArray())
        val payload = enc.encodeToString(payloadJson.toByteArray())
        return "$header.$payload.sig"
    }

    @Test
    fun extractsEmailAndName() {
        val token = jwt("""{"email":"jane@example.com","name":"Jane Doe","sub":"123"}""")
        val claims = IdToken.claims(token)
        assertEquals("jane@example.com", claims.email)
        assertEquals("Jane Doe", claims.name)
    }

    @Test
    fun missingClaimsAreNull() {
        val claims = IdToken.claims(jwt("""{"sub":"123"}"""))
        assertNull(claims.email)
        assertNull(claims.name)
    }

    @Test
    fun malformedOrNullTokenIsSafe() {
        assertNull(IdToken.claims(null).email)
        assertNull(IdToken.claims("").email)
        assertNull(IdToken.claims("not-a-jwt").email)
        assertNull(IdToken.claims("only.two").name) // payload "two" isn't valid base64 JSON
    }
}
