package com.pokoin.cardrails.engine

import android.graphics.Bitmap
import android.graphics.Matrix

data class Match(val record: CardRecord, val score: Float)

sealed class Verdict {
    data class Accepted(val match: Match) : Verdict()
    data class Review(val matches: List<Match>) : Verdict()
    data object None : Verdict()
}

/** Same thresholds as the iPhone app (ios/CardRails/Engine/Recognizer.swift). */
object Thresholds {
    const val ACCEPT = .80f
    const val REVIEW = .60f
    /** The best card with a different name must trail by this much; prints of one card don't count. */
    const val MARGIN = .06f

    fun verdict(matches: List<Match>): Verdict {
        val top = matches.firstOrNull() ?: return Verdict.None
        val rival = matches.drop(1).firstOrNull { it.record.name != top.record.name }
        return when {
            top.score >= ACCEPT && top.score - (rival?.score ?: 0f) >= MARGIN -> Verdict.Accepted(top)
            top.score >= REVIEW -> Verdict.Review(matches)
            else -> Verdict.None
        }
    }
}

/** On-device identification: GPU embed of the crop (and its 180° turn) against the loaded catalog. */
class Recognizer(private val embedder: Embedder, val catalog: LoadedCatalog) {
    fun identify(card: Bitmap, k: Int = 5): List<Match> {
        val upright = search(embedder.embed(card), k)
        val turned = Bitmap.createBitmap(card, 0, 0, card.width, card.height, Matrix().apply { postRotate(180f) }, true)
        val flipped = search(embedder.embed(turned), k)
        return if ((flipped.firstOrNull()?.score ?: 0f) > (upright.firstOrNull()?.score ?: 0f)) flipped else upright
    }

    private fun search(vector: FloatArray, k: Int) =
        catalog.index.search(vector, k).map { Match(catalog.records[it.index], it.score) }
}
