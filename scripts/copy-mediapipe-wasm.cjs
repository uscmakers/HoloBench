const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const sourceDir = path.join(
  rootDir,
  "node_modules",
  "@mediapipe",
  "tasks-vision",
  "wasm"
);
const targetDir = path.join(rootDir, "public", "mediapipe");

function copyContents(source, target) {
  fs.mkdirSync(target, { recursive: true });

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);

    if (entry.isDirectory()) {
      copyContents(sourcePath, targetPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

if (!fs.existsSync(sourceDir)) {
  console.error(`MediaPipe WASM directory not found: ${sourceDir}`);
  process.exit(1);
}

copyContents(sourceDir, targetDir);
console.log("Copied MediaPipe WASM files to public/mediapipe.");