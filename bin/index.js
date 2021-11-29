#!/usr/bin/env node
// import { resolve } from "path";
import path from "path";
import fs from "fs";
import os from "os";
import cpy from "cpy";
const args = process.argv;

const root = path.resolve(args[2]);

if (!fs.existsSync(root)) {
  fs.mkdirSync(root);
}

const packageJson = {
  name: "app name",
  private: true,
  scripts: {
    dev: "next dev",
    build: "next build",
    start: "next start",
    lint: "next lint",
  },
};
fs.writeFileSync(
  path.join(root, "package.json"),
  JSON.stringify(packageJson, null, 2) + os.EOL
);

// const template = typescript ? "typescript" : "default";

const template = "default";

// console.log(__dirname);
console.log(process.cwd());

await cpy("**", root, {
  parents: true,
  cwd: path.join(process.cwd(), "templates", template),
  rename: (name) => {
    switch (name) {
      case "gitignore":
      case "eslintrc.json": {
        return ".".concat(name);
      }
      // README.md is ignored by webpack-asset-relocator-loader used by ncc:
      // https://github.com/vercel/webpack-asset-relocator-loader/blob/e9308683d47ff507253e37c9bcbb99474603192b/src/asset-relocator.js#L227
      case "README-template.md": {
        return "README.md";
      }
      default: {
        return name;
      }
    }
  },
});

// const templatePath = `${__dirname}/template`;
// console.log(templatePath);

// function createDirectoryContents(templatePath, newProjectPath) {
//   const filesToCreate = fs.readdirSync(templatePath);

//   filesToCreate.forEach((file) => {
//     const origFilePath = `${templatePath}/${file}`;

//     // get stats about the current file
//     const stats = fs.statSync(origFilePath);

//     if (stats.isFile()) {
//       const contents = fs.readFileSync(origFilePath, "utf8");

//       const writePath = `${CURR_DIR}/${newProjectPath}/${file}`;
//       fs.writeFileSync(writePath, contents, "utf8");
//     }
//   });
// }

// const CHOICES = readdirSync(path.join(__dirname, "templates"));
// console.log(CHOICES);

// import download from "download-git-repo";

// download("flippidippi/download-git-repo-fixture", "test/tmp", function (err) {
//   console.log(err ? "Error" : "Success");
// });

// import got from "got";
// import tar from "tar";
// import { Stream } from "stream";
// import { promisify } from "util";

// const pipeline = promisify(Stream.pipeline);
// const filePath = "https://codeload.github.com/e-roy/npx-test";
// function downloadAndExtractExample() {
//   return new Promise((resolve, reject) => {
//     resolve(
//       pipeline(
//         got.stream(`https://codeload.github.com/e-roy/npx-test/tar.gz/main`),
//         tar.extract(
//           { cwd: root, strip: filePath ? filePath.split("/").length + 1 : 1 },
//           [`npx-test-main}${filePath ? `/${filePath}` : ""}`]
//         )
//       )
//     );
//   });
// return pipeline(
//   got.stream(`https://codeload.github.com/e-roy/npx-test/tar.gz/main`),
//   tar.extract(
//     { cwd: root, strip: filePath ? filePath.split("/").length + 1 : 1 },
//     [`npx-test-main}${filePath ? `/${filePath}` : ""}`]
//   )
// );
// }
// got.stream(`https://codeload.github.com/e-roy/npx-test/tar.gz/main`),
//   `https://codeload.github.com/${username}/${name}/tar.gz/${branch}`;

// { cwd: root, strip: filePath ? filePath.split("/").length + 1 : 1 },
// [`npx-test-main}${filePath ? `/${filePath}` : ""}`]

// let result = await downloadAndExtractExample();
// console.log(result);
