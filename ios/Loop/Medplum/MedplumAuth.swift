import AuthenticationServices
import CryptoKit
import Foundation
import Observation

/// OAuth2 authorization code + PKCE against Medplum.
///
/// The app is a *public* client: it holds no secret. The proof is a verifier
/// generated fresh per login, so there is nothing in the binary worth stealing.
/// The resulting token is scoped to one patient by Medplum's access policy.
@MainActor
@Observable
final class MedplumAuth: NSObject {
    private(set) var isSignedIn = false
    private(set) var patientID: String?
    private(set) var displayName: String?
    private(set) var error: String?

    private var accessToken: String?
    private var refreshToken: String?
    private var expiresAt: Date?

    private var session: ASWebAuthenticationSession?

    // MARK: - Session restore

    func restore() async {
        refreshToken = Keychain.read(.refreshToken)
        guard refreshToken != nil else { return }
        await refreshIfNeeded(force: true)
    }

    // MARK: - Sign in

    func signIn() async {
        error = nil
        let verifier = Self.randomURLSafe(64)
        let challenge = Self.s256(verifier)

        var components = URLComponents(url: Config.medplumBaseURL.appending(path: "oauth2/authorize"),
                                       resolvingAgainstBaseURL: false)!
        components.queryItems = [
            .init(name: "response_type", value: "code"),
            .init(name: "client_id", value: Config.medplumClientID),
            .init(name: "redirect_uri", value: Config.medplumRedirectURI),
            .init(name: "scope", value: "openid profile"),
            .init(name: "code_challenge", value: challenge),
            .init(name: "code_challenge_method", value: "S256"),
        ]

        guard let url = components.url else { return }

        do {
            let callback = try await authenticate(url: url)
            guard let code = URLComponents(url: callback, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "code" })?.value
            else {
                error = "Medplum didn't return a sign-in code."
                return
            }
            try await exchange(code: code, verifier: verifier)
            await loadProfile()
        } catch is CancellationError {
            // user closed the sheet; not an error worth showing
        } catch {
            let nsError = error as NSError
            if nsError.domain == ASWebAuthenticationSessionErrorDomain,
               nsError.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                return
            }
            self.error = "Couldn't sign in. \(error.localizedDescription)"
        }
    }

    func signOut() {
        Keychain.delete(.refreshToken)
        accessToken = nil
        refreshToken = nil
        expiresAt = nil
        patientID = nil
        displayName = nil
        isSignedIn = false
    }

    /// A valid bearer token, refreshing first if it's close to expiry.
    func token() async -> String? {
        await refreshIfNeeded()
        return accessToken
    }

    // MARK: - Token plumbing

    private func authenticate(url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: url,
                callback: .customScheme(Config.medplumRedirectScheme)
            ) { callbackURL, error in
                if let callbackURL {
                    continuation.resume(returning: callbackURL)
                } else {
                    continuation.resume(throwing: error ?? CancellationError())
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            session.start()
        }
    }

    private func exchange(code: String, verifier: String) async throws {
        try await requestToken([
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": Config.medplumRedirectURI,
            "client_id": Config.medplumClientID,
            "code_verifier": verifier,
        ])
    }

    private func refreshIfNeeded(force: Bool = false) async {
        guard let refreshToken else { return }
        let stillFresh = (expiresAt ?? .distantPast) > Date().addingTimeInterval(60)
        guard force || !stillFresh else { return }
        do {
            try await requestToken([
                "grant_type": "refresh_token",
                "refresh_token": refreshToken,
                "client_id": Config.medplumClientID,
            ])
            if patientID == nil { await loadProfile() }
        } catch {
            // Refresh token is dead — make the person sign in again rather than
            // silently failing every write from here on.
            signOut()
        }
    }

    private func requestToken(_ fields: [String: String]) async throws {
        var request = URLRequest(url: Config.medplumBaseURL.appending(path: "oauth2/token"))
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = fields
            .map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? $0.value)" }
            .joined(separator: "&")
            .data(using: .utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw MedplumError.http(String(decoding: data, as: UTF8.self))
        }

        let token = try JSONDecoder().decode(TokenResponse.self, from: data)
        accessToken = token.access_token
        expiresAt = Date().addingTimeInterval(TimeInterval(token.expires_in ?? 3600))
        if let refresh = token.refresh_token {
            refreshToken = refresh
            Keychain.write(refresh, to: .refreshToken)
        }
        isSignedIn = true
    }

    /// Medplum tells us which Patient this login maps to; we never guess it.
    private func loadProfile() async {
        guard let accessToken else { return }
        var request = URLRequest(url: Config.medplumBaseURL.appending(path: "auth/me"))
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let profile = json["profile"] as? [String: Any]
        else { return }

        patientID = profile["id"] as? String
        if let names = profile["name"] as? [[String: Any]], let name = names.first {
            let given = (name["given"] as? [String])?.joined(separator: " ") ?? ""
            let family = name["family"] as? String ?? ""
            displayName = "\(given) \(family)".trimmingCharacters(in: .whitespaces)
        }
    }

    private struct TokenResponse: Decodable {
        let access_token: String
        let refresh_token: String?
        let expires_in: Int?
    }

    // MARK: - PKCE

    private static func randomURLSafe(_ count: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: count)
        _ = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        return Data(bytes).base64URLEncoded
    }

    private static func s256(_ verifier: String) -> String {
        Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncoded
    }
}

extension MedplumAuth: ASWebAuthenticationPresentationContextProviding {
    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            return scenes.first?.keyWindow ?? ASPresentationAnchor()
        }
    }
}

enum MedplumError: LocalizedError {
    case notSignedIn
    case http(String)

    var errorDescription: String? {
        switch self {
        case .notSignedIn: "You're signed out of Medplum."
        case .http(let detail): detail
        }
    }
}

extension Data {
    var base64URLEncoded: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
