import Foundation

/// Server-known account roles (`ApiUser.role`, see `APIClient.swift`): "owner" can write dose
/// settings; "viewer" is read-only and the server rejects any write. An unrecognized or missing role
/// (not yet signed in, or a role string the app doesn't know) is treated as `.viewer`, so a fresh or
/// ambiguous state never grants edit access by accident.
public enum AccountRole: Equatable, Sendable {
    case owner
    case viewer

    public init(_ raw: String?) {
        self = raw == "owner" ? .owner : .viewer
    }
}

/// Whether the signed-in user's cached role permits editing dose settings. The one shared source for
/// `AppModel.isOwner`, `SettingsView`'s "New version…" row and `DoseSettingsEditorView`'s Save button,
/// so a viewer can never reach a working editor from any of them (the server would reject the write
/// anyway, but the app should never let a viewer get that far).
public func canEditDoseSettings(role: AccountRole) -> Bool { role == .owner }
