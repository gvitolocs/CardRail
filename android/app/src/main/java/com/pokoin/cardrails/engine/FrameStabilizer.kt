package com.pokoin.cardrails.engine

import kotlin.math.abs
import kotlin.math.hypot

data class Point(val x: Float, val y: Float)

class FrameStabilizer(
    private val centerTolerance: Float = .025f,
    private val areaTolerance: Float = .06f,
    private val requiredStillFrames: Int = 2,
) {
    private var previous: Sample? = null
    private var stillCount = 0
    private data class Sample(val center: Point, val area: Float)

    fun reset() { previous = null; stillCount = 0 }

    fun observe(quad: List<Point>): Boolean {
        if (quad.size != 4) { reset(); return false }
        val sample = Sample(
            Point(quad.sumOf { it.x.toDouble() }.toFloat() / 4,
                quad.sumOf { it.y.toDouble() }.toFloat() / 4),
            polygonArea(quad)
        )
        val old = previous
        previous = sample
        if (old == null) { stillCount = 1; return false }
        val moved = hypot(sample.center.x - old.center.x, sample.center.y - old.center.y)
        val changed = abs(sample.area - old.area) / old.area.coerceAtLeast(.0001f)
        stillCount = if (moved < centerTolerance && changed < areaTolerance) stillCount + 1 else 1
        return stillCount >= requiredStillFrames
    }

    private fun polygonArea(points: List<Point>): Float =
        abs(points.indices.sumOf { i ->
            val a = points[i]; val b = points[(i + 1) % points.size]
            (a.x * b.y - b.x * a.y).toDouble()
        }).toFloat() / 2f
}
