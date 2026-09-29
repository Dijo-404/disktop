import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveLocations } from "../../dist/storage/xdg.js";

test("XDG variables win and each area gets its own disktop directory", () => {
  const locations = resolveLocations(
    {
      XDG_CONFIG_HOME: "/xdg/config",
      XDG_DATA_HOME: "/xdg/data",
      XDG_CACHE_HOME: "/xdg/cache",
      XDG_STATE_HOME: "/xdg/state",
    },
    "/home/example",
  );
  assert.deepEqual(locations, {
    configDirectory: "/xdg/config/disktop",
    configFile: "/xdg/config/disktop/config.toml",
    dataDirectory: "/xdg/data/disktop",
    cacheDirectory: "/xdg/cache/disktop",
    stateDirectory: "/xdg/state/disktop",
  });
});

test("unset variables fall back to the standard home locations", () => {
  const locations = resolveLocations({}, "/home/example");
  assert.equal(locations.configFile, "/home/example/.config/disktop/config.toml");
  assert.equal(locations.dataDirectory, "/home/example/.local/share/disktop");
  assert.equal(locations.cacheDirectory, "/home/example/.cache/disktop");
  assert.equal(locations.stateDirectory, "/home/example/.local/state/disktop");
});

test("a relative XDG value is ignored, as the specification requires", () => {
  const locations = resolveLocations({ XDG_STATE_HOME: "relative/state" }, "/home/example");
  assert.equal(locations.stateDirectory, "/home/example/.local/state/disktop");
});

test("a missing home directory is an explicit failure, not a path under the root", () => {
  assert.throws(() => resolveLocations({}, ""), /home directory/);
});
