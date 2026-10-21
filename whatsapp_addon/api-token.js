const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { RequestValidationError } = require("./validation");

const API_TOKEN_FILE = ".api-token";

const normalizeApiToken = (value) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !/^[-A-Za-z0-9._~+/]+=*$/.test(value)
  ) {
    throw new RequestValidationError("The internal API credential is invalid.");
  }
  return value;
};

const readToken = async (filename, fsPromises) => {
  let handle;
  try {
    handle = await fsPromises.open(
      filename,
      fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW || 0) |
        (fs.constants.O_NONBLOCK || 0)
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 513) {
      throw new Error("Invalid credential file.");
    }
    // Reject symlinks on platforms without O_NOFOLLOW as well.
    if ((await fsPromises.lstat(filename)).isSymbolicLink()) {
      throw new Error("Invalid credential file.");
    }
    const token = normalizeApiToken((await handle.readFile("utf8")).trim());
    if (!token) throw new Error("Invalid credential file.");
    await handle.chmod(0o600);
    return token;
  } finally {
    await handle?.close();
  }
};

const loadOrCreateApiToken = async ({
  dataRoot,
  legacyToken,
  fsPromises = fs.promises,
}) => {
  const filename = path.join(dataRoot, API_TOKEN_FILE);
  let temporary;
  try {
    try {
      return await readToken(filename, fsPromises);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await fsPromises.mkdir(dataRoot, { recursive: true, mode: 0o700 });
    const token = normalizeApiToken(legacyToken) || crypto.randomBytes(32).toString("hex");
    temporary = path.join(dataRoot, `${API_TOKEN_FILE}.${crypto.randomUUID()}.tmp`);
    const handle = await fsPromises.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${token}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      // Publish a complete file atomically without replacing another starter's token.
      await fsPromises.link(temporary, filename);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    return await readToken(filename, fsPromises);
  } catch {
    // Never fall back to an unauthenticated API or log filesystem/secret details.
    throw new Error("Could not prepare internal API authentication.");
  } finally {
    if (temporary) await fsPromises.unlink(temporary).catch(() => {});
  }
};

module.exports = { API_TOKEN_FILE, loadOrCreateApiToken, normalizeApiToken };
