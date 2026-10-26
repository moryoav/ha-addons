/** Validate pairing requests and keep temporary codes tied to one Baileys socket. */
const { withTimeout } = require("./timeout");

const REQUEST_COOLDOWN_MS = 30_000;

/** Describe a pairing failure without exposing credentials or upstream messages. */
class PairingActionError extends Error {
  /** Store the public HTTP status, stable error code, and safe recovery advice. */
  constructor(status, code, message) {
    super(message);
    this.name = "PairingActionError";
    this.status = status;
    this.code = code;
  }
}

/** Accept common phone formatting and return international digits for Baileys. */
const normalizePairingPhone = (value) => {
  if (typeof value === "string" && value.length <= 64 && /^\+?[\d ()-]+$/.test(value.trim())) {
    const digits = value.trim().replace(/[ ()-]/g, "").replace(/^\+/, "");
    if (/^[1-9]\d{6,14}$/.test(digits)) return digits;
  }
  throw new PairingActionError(400, "invalid_phone_number", "Enter your WhatsApp phone number including its country code.");
};

/** Remove a leftover phone code, and its provisional identity when linking never finished. */
const clearUnregisteredPairing = (creds) => {
  if (creds?.registered !== false || !creds.pairingCode) return false;
  // Baileys stores the signed account at pair-success, including QR scans after a code request.
  if (!creds.account) delete creds.me;
  delete creds.pairingCode;
  return true;
};

/** Build an authenticated Home Assistant entry link from the installed app slug. */
const pairingWebUiPath = (slug, coreVersion) => {
  if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug)) return null;
  // Home Assistant 2026.2 moved Ingress from the Hass.io panel to the app panel.
  const version = typeof coreVersion === "string" && /^(\d{4})\.(\d{1,2})(?:\.|$)/.exec(coreVersion);
  const modern = version && (Number(version[1]) > 2026 || (Number(version[1]) === 2026 && Number(version[2]) >= 2));
  return modern ? `/app/${slug}` : `/hassio/ingress/${slug}`;
};

/** Own the choice, request lock, and temporary code for one unpaired socket. */
class PairingSession {
  #socket;
  #creds;
  #saveCreds;
  #onUpdate;
  #ready = false;
  #closed = false;
  #paired = false;
  #pending = false;
  #method = "qr";

  /** Bind lifecycle changes to the same credentials and socket used by Baileys. */
  constructor({ socket, creds, saveCreds, onUpdate }) {
    this.#socket = socket;
    this.#creds = creds;
    this.#saveCreds = saveCreds;
    this.#onUpdate = onUpdate;
  }

  /** Mark the handshake ready and tell the caller whether to display this QR. */
  onQr() {
    this.#ready = true;
    return !this.#closed && !this.#paired && this.#method === "qr";
  }

  /** Reject actions after linking, before the handshake, or during another request. */
  requireAvailable() {
    if (this.#closed || this.#paired || this.#creds?.registered === true || !this.#ready) {
      throw new PairingActionError(409, "pairing_unavailable", "Wait for the pairing page to be ready, then try again.");
    }
    if (this.#pending) {
      throw new PairingActionError(409, "pairing_busy", "A pairing request is already in progress.");
    }
  }

  /** Generate one code after the QR handshake, with a bounded upstream wait. */
  async requestCode(phoneNumber) {
    const phone = normalizePairingPhone(phoneNumber);
    this.requireAvailable();
    this.#pending = true;
    this.#method = "phone";
    this.#onUpdate({ method: "phone", pending: true, code: null });
    try {
      const code = await withTimeout(this.#socket.requestPairingCode(phone), "Pairing request");
      if (this.#closed || this.#paired || this.#creds?.registered === true) {
        throw new PairingActionError(409, "pairing_changed", "The pairing session changed. Refresh the page before trying again.");
      }
      if (typeof code !== "string" || !/^[A-Z0-9]{8}$/i.test(code)) throw new Error("Invalid pairing code.");
      const formatted = `${code.slice(0, 4)}-${code.slice(4)}`.toUpperCase();
      this.#onUpdate({ method: "phone", pending: false, code: formatted });
      return formatted;
    } catch (error) {
      if (!this.#closed && !this.#paired) {
        this.close();
        // Retire uncertain requests, including timeouts, before accepting another code.
        await Promise.resolve(this.#socket.end?.()).catch(() => {});
      }
      if (error instanceof PairingActionError) throw error;
      throw new PairingActionError(502, "pairing_failed", "WhatsApp could not generate a pairing code. Try again.");
    } finally {
      this.#pending = false;
    }
  }

  /** Clear displayed secrets after successful linking without erasing credentials. */
  complete() {
    this.#paired = true;
    this.close();
  }

  /** Invalidate code responses and remove unfinished identities before reconnecting. */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#ready = false;
    if (!this.#paired && clearUnregisteredPairing(this.#creds)) this.#saveCreds();
    this.#onUpdate({ method: "qr", pending: false, code: null });
  }
}

module.exports = {
  PairingActionError,
  PairingSession,
  REQUEST_COOLDOWN_MS,
  clearUnregisteredPairing,
  normalizePairingPhone,
  pairingWebUiPath,
};
