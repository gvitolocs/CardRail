package com.pokoin.cardrails.engine

import com.pokoin.cardrails.api.AuthResponse
import com.pokoin.cardrails.api.CommitResponse
import com.pokoin.cardrails.api.InventoryResponse
import com.pokoin.cardrails.api.ItemResponse
import com.pokoin.cardrails.api.MeResponse
import com.pokoin.cardrails.api.OkResponse
import com.pokoin.cardrails.api.PhotoResponse
import com.pokoin.cardrails.api.SettingsResponse
import com.pokoin.cardrails.api.APIClient
import com.pokoin.cardrails.api.apiJson
import com.pokoin.cardrails.state.TrayLine
import com.pokoin.cardrails.state.mergeIntoTray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.random.Random

class EngineTest {
    private fun resource(name: String): String =
        requireNotNull(javaClass.classLoader!!.getResource(name)) { "missing test resource $name" }.readText()

    @Test fun halfConversion() {
        assertEquals(1f, halfToFloat(0x3C00), 0f)
        assertEquals(-2f, halfToFloat(0xC000), 0f)
        assertEquals(0.5f, halfToFloat(0x3800), 0f)
        assertEquals(65504f, halfToFloat(0x7BFF), 0f)
        assertEquals(5.9604645e-8f, halfToFloat(0x0001), 1e-14f)
        assertEquals(0f, halfToFloat(0x0000), 0f)
        assertEquals(Float.POSITIVE_INFINITY, halfToFloat(0x7C00), 0f)
    }

    /** Float → half bits for building test files (round-to-nearest is fine for normalized values). */
    private fun floatToHalf(value: Float): Short {
        val bits = value.toRawBits()
        val sign = (bits ushr 16) and 0x8000
        val exponent = ((bits ushr 23) and 0xFF) - 127 + 15
        val mantissa = bits and 0x7FFFFF
        if (exponent <= 0) return sign.toShort()
        return (sign or (exponent shl 10) or (mantissa ushr 13)).toShort()
    }

    @Test fun f16CatalogFindsItsOwnRows() {
        val rnd = Random(7)
        val count = 500; val dim = 128
        val rows = Array(count) { l2Normalize(FloatArray(dim) { rnd.nextFloat() * 2 - 1 }) }
        val buffer = ByteBuffer.allocate(count * dim * 2).order(ByteOrder.LITTLE_ENDIAN)
        rows.forEach { row -> row.forEach { buffer.putShort(floatToHalf(it)) } }
        val index = VectorIndex.fromF16(buffer.array(), count, dim)
        val hits = index.search(rows[123], 3)
        assertEquals(123, hits.first().index)
        assertEquals(1f, hits.first().score, 2e-3f)
        assertTrue(hits[0].score >= hits[1].score && hits[1].score >= hits[2].score)
        assertEquals(count, index.search(rows[0], 10_000).size)
        assertTrue(VectorIndex(FloatArray(0), 0, dim).search(rows[0], 3).isEmpty())
    }

    @Test fun catalogSelectionMatchesIos() {
        fun entry(id: String, game: String, vararg languages: String) =
            CatalogEntry(id, game, languages.toList(), 1, CatalogFile("$id/e.f16", 1, "x"), CatalogFile("$id/c.json", 1, "x"))
        val index = CatalogIndex(1, listOf(
            entry("pokemon_western", "pokemon", "EN", "IT", "FR", "DE", "ES", "PT"),
            entry("pokemon_japanese", "pokemon", "JP"),
            entry("pokemon_chinese", "pokemon", "ZH"),
            entry("magic_all", "magic", "*"),
        ))
        assertEquals("pokemon_japanese", index.catalogFor("pokemon", "JP")?.id)
        assertEquals("pokemon_western", index.catalogFor("pokemon", "KO")?.id)
        assertEquals("magic_all", index.catalogFor("magic", "IT")?.id)
        assertEquals(null, index.catalogFor("chess", "EN"))
        assertEquals(Languages.all, index.languagesFor("magic"))
        assertFalse("KO" in index.languagesFor("pokemon"))
    }

    private fun match(name: String, score: Float) = Match(CardRecord(name + score, name, null, null, null), score)

    @Test fun verdictMatchesIosCases() {
        assertTrue(Thresholds.verdict(listOf(match("Momonosuke", .897f), match("DON!!", .787f))) is Verdict.Accepted)
        assertTrue(Thresholds.verdict(listOf(match("Sabo", .84f), match("Ace", .81f))) is Verdict.Review)
        assertTrue(Thresholds.verdict(listOf(match("Momonosuke", .90f), match("Momonosuke", .89f), match("DON!!", .70f))) is Verdict.Accepted)
        assertEquals(Verdict.None, Thresholds.verdict(listOf(match("Sabo", .55f))))
        assertTrue(Thresholds.verdict(listOf(match("Sabo", .70f))) is Verdict.Review)
        assertEquals(Verdict.None, Thresholds.verdict(emptyList()))
    }

    @Test fun trayMergesOnlyIdenticalVariants() {
        fun line(id: String, condition: String = "NM") =
            TrayLine(id, "p1", "Pikachu", game = "pokemon", language = "EN", condition = condition, printing = "Standard")
        var tray = mergeIntoTray(emptyList(), line("a"), mergeRepeats = true)
        tray = mergeIntoTray(tray, line("b"), mergeRepeats = true)
        assertEquals(1, tray.size); assertEquals(2, tray[0].quantity)
        tray = mergeIntoTray(tray, line("c", "SP"), mergeRepeats = true)
        assertEquals(2, tray.size)
        assertEquals(3, mergeIntoTray(tray, line("d"), mergeRepeats = false).size)
    }

    @Test fun stabilizerNeedsTwoStillFrames() {
        val s = FrameStabilizer()
        val q = listOf(Point(.2f, .2f), Point(.6f, .2f), Point(.6f, .8f), Point(.2f, .8f))
        assertFalse(s.observe(q)); assertTrue(s.observe(q))
        assertFalse(s.observe(q.map { Point(it.x + .1f, it.y) }))
        s.reset(); assertFalse(s.observe(q))
    }

    @Test fun cardsFileParses() {
        val cards = parseCards("""{"fields":["id","name","number","set","image"],"rows":[["7","Pikachu","58","Base",null],["8","Mew",null,null,"https://x/8.jpg"]]}""")
        assertEquals(2, cards.size)
        assertEquals(CardRecord("7", "Pikachu", "58", "Base", null), cards[0])
        assertEquals("https://x/8.jpg", cards[1].imageUrl)
    }

    @Test fun serverFallbackHitsMap() {
        val matches = ServerScanClient.parseIdentify(resource("identify_one_piece.json"))
        assertEquals("Kouzuki Momonosuke", matches.first().record.name)
        assertEquals("OP16-085a", matches.first().record.number)
        assertTrue(matches.first().record.id.isNotEmpty())
        assertTrue(Thresholds.verdict(matches) is Verdict.Accepted)
    }

    /** The same recorded live-API payloads the iPhone contract test decodes. */
    @Test fun recordedApiPayloadsDecode() {
        assertEquals("TEST_TOKEN", apiJson.decodeFromString<AuthResponse>(resource("api/signup.json")).token)
        assertNotNull(apiJson.decodeFromString<MeResponse>(resource("api/me.json")).account.email)
        val inventory = apiJson.decodeFromString<InventoryResponse>(resource("api/inventory.json"))
        assertTrue(inventory.items.isNotEmpty())
        assertNotNull(inventory.items.first().location)
        apiJson.decodeFromString<SettingsResponse>(resource("api/settings_put.json"))
        assertTrue(apiJson.decodeFromString<PhotoResponse>(resource("api/photo_post.json")).id.startsWith("photo_"))
        assertTrue(apiJson.decodeFromString<CommitResponse>(resource("api/scans_post.json")).items.isNotEmpty())
        apiJson.decodeFromString<ItemResponse>(resource("api/item_patch.json"))
        apiJson.decodeFromString<OkResponse>(resource("api/item_delete.json"))
        assertEquals("Email or password is wrong.", APIClient.errorMessage(resource("api/error_401.json")))
    }
}
