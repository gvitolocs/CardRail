import SwiftUI

struct LoginView: View {
    @EnvironmentObject private var model: AppModel

    private enum Mode: String, CaseIterable { case login = "Accedi", signup = "Registrati" }

    @State private var mode: Mode = .login
    @State private var email = ""
    @State private var password = ""
    @State private var error: String?
    @State private var busy = false

    private var canSubmit: Bool {
        !email.trimmingCharacters(in: .whitespaces).isEmpty && password.count >= 4 && !busy
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                Spacer(minLength: 60)

                Image("Logo")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 96, height: 96)
                    .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))

                Text("Card Rails")
                    .font(.display(34))
                    .foregroundStyle(Theme.text)

                Picker("Modalità", selection: $mode) {
                    ForEach(Mode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .onChange(of: mode) { _, _ in error = nil }

                VStack(spacing: 12) {
                    TextField("Email", text: $email)
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textFieldStyle(.plain)
                        .padding(14)
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: Theme.corner))
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.corner).stroke(Theme.line)
                        )

                    SecureField("Password", text: $password)
                        .textContentType(mode == .login ? .password : .newPassword)
                        .textFieldStyle(.plain)
                        .padding(14)
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: Theme.corner))
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.corner).stroke(Theme.line)
                        )
                }

                Button(action: submit) {
                    ZStack {
                        Text(mode == .login ? "Accedi" : "Crea account")
                            .font(.headline)
                            .opacity(busy ? 0 : 1)
                        if busy {
                            ProgressView().tint(.white)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 52)
                }
                .background(Theme.accent, in: RoundedRectangle(cornerRadius: Theme.corner))
                .foregroundStyle(Theme.text)
                .disabled(!canSubmit)
                .opacity(canSubmit ? 1 : 0.5)

                if let error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(Theme.accent)
                        .multilineTextAlignment(.center)
                }

                Spacer(minLength: 40)
            }
            .padding(.horizontal, 28)
        }
        .background(Theme.background)
        .scrollDismissesKeyboard(.interactively)
    }

    private func submit() {
        guard canSubmit else { return }
        busy = true
        error = nil
        Task {
            do {
                if mode == .login {
                    try await model.login(email: email, password: password)
                } else {
                    try await model.signup(email: email, password: password)
                }
            } catch let apiError as APIError {
                error = Self.describe(apiError)
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }

    private static func describe(_ error: APIError) -> String {
        switch error {
        case .server(_, let message): return message
        case .invalidResponse: return "Risposta non valida dal server."
        case .transport: return "Impossibile contattare il server."
        }
    }
}
