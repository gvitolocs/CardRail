package com.pokoin.cardrails.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable data class Account(val id: String, val email: String, val createdAt: String? = null)
@Serializable data class AuthResponse(val account: Account, val token: String)
@Serializable data class MeResponse(val account: Account)
@Serializable data class Credentials(val email: String, val password: String, val client: String = "android")
@Serializable data class InventoryIdentity(val game: String, val name: String, val setName: String, val number: String, val publicId: String, val cardtraderBlueprintId: String)
@Serializable data class InventoryLocation(val box: String? = null, val row: String? = null, val position: Int? = null, val end: Int? = null, val stackSize: Int? = null)
@Serializable data class ScanPhoto(val id: String, val sha256: String, val bytes: Int, val capturedAt: String? = null, val role: String, val url: String)
@Serializable data class InventoryItem(val id: String, val identity: InventoryIdentity, val art: String, val language: String, val condition: String, val printing: String, val firstEdition: Boolean, val signed: Boolean, val altered: Boolean, val purpose: String, val quantity: Int, val price: Double, val currency: String, val source: String, val location: InventoryLocation? = null, val scanPhoto: ScanPhoto? = null, val version: Int, val createdAt: String? = null, val updatedAt: String? = null)
@Serializable data class ScanSettings(
    var game: String = "pokemon", var language: String = "EN", var condition: String = "NM",
    var printing: String = "Standard", var firstEdition: Boolean = false, var signed: Boolean = false,
    var altered: Boolean = false, var storageLabel: String = "", var stackSize: Int? = null,
    var stack: Int = 1, var startPosition: Int = 1, var mergeRepeats: Boolean = true,
    var paused: Boolean = false, var locationConfigured: Boolean = false
) { companion object { val Default = ScanSettings() } }
@Serializable data class InventoryResponse(val items: List<InventoryItem>, val scanSettings: ScanSettings, val revision: Int)
@Serializable data class SettingsResponse(val scanSettings: ScanSettings, val revision: Int)
@Serializable data class ScanSettingsUpdate(val game: String? = null, val language: String? = null, val condition: String? = null, val printing: String? = null, val firstEdition: Boolean? = null, val signed: Boolean? = null, val altered: Boolean? = null, val storageLabel: String? = null, val stackSize: Int? = null, val stack: Int? = null, val startPosition: Int? = null, val mergeRepeats: Boolean? = null, val paused: Boolean? = null)
@Serializable data class PhotoResponse(val id: String, val sha256: String, val bytes: Int, val url: String)
@Serializable data class ScanIdentity(val game: String, val name: String, val setName: String, val number: String, val publicId: String, val cardtraderBlueprintId: String = "")
@Serializable data class ScanCard(val identity: ScanIdentity, val art: String, val language: String, val condition: String, val printing: String, val firstEdition: Boolean, val signed: Boolean, val altered: Boolean, val quantity: Int, val price: Double = 0.0, val photoId: String? = null)
@Serializable data class ScanCommit(val idempotencyKey: String, val intent: String, val cards: List<ScanCard>)
@Serializable data class CommitResponse(val items: List<InventoryItem>, val revision: Int)
@Serializable data class ItemPatch(val version: Int, val quantity: Int? = null, val price: Double? = null, val condition: String? = null, val language: String? = null, val printing: String? = null, val firstEdition: Boolean? = null, val signed: Boolean? = null, val altered: Boolean? = null)
@Serializable data class ItemResponse(val item: InventoryItem, val revision: Int)
@Serializable data class OkResponse(val ok: Boolean, val revision: Int? = null)
