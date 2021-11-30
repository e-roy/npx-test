#!/usr/bin/env node
// import path from "path";
import fs from "fs";
// import os from "os";
// import cpy from "cpy";

// const args = process.argv;

// const root = path.resolve(args[2]);
const root = "something";

// const packageJson = {
//   name: "app-name",
//   private: true,
//   scripts: {
//     dev: "next dev",
//     build: "next build",
//     start: "next start",
//     lint: "next lint",
//   },
// };

const buildPackage = () => {
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root);
  }

  // fs.writeFileSync(
  //   path.join(root, "package.json"),
  //   JSON.stringify(packageJson, null, 2) + os.EOL
  // );

  // copyFiles();
};

// const copyFiles = async () => {
//   await cpy("**", root, {
//     parents: true,
//     cwd: path.join(process.cwd(), "templates", "default"),
//     rename: (name) => {
//       switch (name) {
//         case "gitignore":
//         case "eslintrc.json": {
//           return ".".concat(name);
//         }
//         // README.md is ignored by webpack-asset-relocator-loader used by ncc:
//         // https://github.com/vercel/webpack-asset-relocator-loader/blob/e9308683d47ff507253e37c9bcbb99474603192b/src/asset-relocator.js#L227
//         case "README-template.md": {
//           return "README.md";
//         }
//         default: {
//           return name;
//         }
//       }
//     },
//   });
// };

function run() {
  // console.log("running");
  buildPackage();
}

run();
