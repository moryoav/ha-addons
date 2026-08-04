const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ADDON_ROOT = path.resolve(__dirname, "..");

test("AppArmor confines Node after the trusted base-image bootstrap", () => {
  const profile = fs.readFileSync(
    path.join(ADDON_ROOT, "apparmor.txt"),
    "utf8"
  );

  assert.equal(profile.match(/^\s*file,\s*$/gm)?.length, 1);
  assert.match(profile, /^\s*\/init\s+rix,\s*$/m);
  const transitionIndex = profile.search(
    /^\s*\/usr\/bin\/node\s+cx\s+->\s+node,\s*$/m
  );
  assert.notEqual(transitionIndex, -1);

  const childStart = profile.indexOf("  profile node ");
  assert.ok(childStart > transitionIndex);
  assert.ok(profile.search(/^\s*file,\s*$/m) < childStart);
  const childProfile = profile.slice(childStart);
  assert.match(childProfile, /^\s*#include <abstractions\/base>\s*$/m);
  assert.match(childProfile, /^\s*#include <abstractions\/nameservice>\s*$/m);
  assert.match(childProfile, /^\s*#include <abstractions\/ssl_certs>\s*$/m);
  assert.equal(
    childProfile.match(/^\s*network inet stream,\s*$/gm)?.length,
    1
  );
  assert.equal(
    childProfile.match(/^\s*network inet6 stream,\s*$/gm)?.length,
    1
  );
  assert.equal(
    childProfile.match(/^\s*network inet dgram,\s*$/gm)?.length,
    1
  );
  assert.equal(
    childProfile.match(/^\s*network inet6 dgram,\s*$/gm)?.length,
    1
  );
  assert.equal(
    childProfile.match(
      /^\s*signal \(receive\) peer=whatsapp_addon,\s*$/gm
    )?.length,
    1
  );
  assert.equal(
    childProfile.match(
      /^\s*signal \(receive\) peer=\*_whatsapp_addon,\s*$/gm
    )?.length,
    1
  );
  assert.match(childProfile, /^\s*\/\*\*\s+r,\s*$/m);
  assert.match(childProfile, /^\s*\/usr\/bin\/node\s+mr,\s*$/m);
  assert.match(childProfile, /^\s*\/node_modules\/\{,\*\*\}\s+mr,\s*$/m);
  assert.match(childProfile, /^\s*\/tmp\/\{,\*\*\}\s+rwk,\s*$/m);
  assert.match(childProfile, /^\s*\/data\/\{,\*\*\}\s+rwk,\s*$/m);
  assert.doesNotMatch(childProfile, /^\s*file,\s*$/m);
  assert.doesNotMatch(childProfile, /^\s*\/\S+\s+\S*x\S*,\s*$/m);

  const runScript = fs.readFileSync(path.join(ADDON_ROOT, "run.sh"), "utf8");
  assert.match(runScript, /^exec \/usr\/bin\/node \/index\.js\r?$/m);
});
