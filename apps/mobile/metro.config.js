const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

if (!config.resolver.assetExts.includes("onnx")) {
  config.resolver.assetExts.push("onnx");
}

module.exports = config;