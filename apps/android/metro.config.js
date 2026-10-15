const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

// Share protocol sources without resolving the desktop React runtime.
const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, "../../packages/tpa-remote")];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules"), path.resolve(__dirname, "../../packages/tpa-remote/node_modules")];
// Expo keeps some of its native dependencies nested. Normal package lookup is
// required there; shared protocol sources import no desktop React components.
config.resolver.disableHierarchicalLookup = false;
module.exports = config;
