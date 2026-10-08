package com.pokoin.cardrails.api

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The app's dictionary must match `GET /v1/dictionary` (fixture shared with iOS and web). */
class CodesTest {
    private fun table(values: List<String>) = values.mapIndexed { i, v -> "${i + 1}" to v }.toMap()

    @Test fun dictionaryMatchesTheApi() {
        val text = javaClass.classLoader!!.getResource("api/dictionary.json")!!.readText()
        val server = Json.parseToJsonElement(text).jsonObject
        fun section(name: String) = server[name]!!.jsonObject.mapValues { it.value.jsonPrimitive.content }
        assertEquals(Codes.VERSION, server["version"]!!.jsonPrimitive.int)
        assertEquals(table(Codes.games), section("games"))
        assertEquals(table(Codes.languages), section("languages"))
        assertEquals(table(Codes.conditions), section("conditions"))
        assertEquals(table(Codes.printings), section("printings"))
        assertEquals("imported", section("flags")["16"])
    }

    @Test fun lookups() {
        assertEquals(2, Codes.code("IT", Codes.languages))
        assertEquals("JP", Codes.value(5, Codes.languages))
        assertNull(Codes.value(0, Codes.languages))
        assertNull(Codes.code("Etched Foil", Codes.printings))
    }
}
