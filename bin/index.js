#!/usr/bin/env node
import path from "path";
import fs from "fs";
import os from "os";
// import cpy from "cpy";
// import child_process from "child_process";
// import fse from "fs-extra";

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

const content = path.join(process.cwd(), "templates", "default");
// console.log(content);

function copyFileSync(source, target) {
  var targetFile = target;

  // If target is a directory, a new file with the same name will be created
  if (fs.existsSync(target)) {
    if (fs.lstatSync(target).isDirectory()) {
      targetFile = path.join(target, path.basename(source));
    }
  }

  fs.writeFileSync(targetFile, fs.readFileSync(source));
}

function copyFolderRecursiveSync(source, target) {
  var files = [];

  // Check if folder needs to be created or integrated
  var targetFolder = path.join(target, path.basename(source));
  if (!fs.existsSync(targetFolder)) {
    fs.mkdirSync(targetFolder);
  }

  // Copy
  if (fs.lstatSync(source).isDirectory()) {
    files = fs.readdirSync(source);
    files.forEach(function (file) {
      var curSource = path.join(source, file);
      if (fs.lstatSync(curSource).isDirectory()) {
        copyFolderRecursiveSync(curSource, targetFolder);
      } else {
        copyFileSync(curSource, targetFolder);
      }
    });
  }
}

copyFolderRecursiveSync(content, root);

// async function copyDir(src, dest) {
//   await fs.mkdir(dest, { recursive: true });
//   let entries = await fs.readdir(src, { withFileTypes: true });

//   for (let entry of entries) {
//     let srcPath = path.join(src, entry.name);
//     let destPath = path.join(dest, entry.name);

//     entry.isDirectory()
//       ? await copyDir(srcPath, destPath)
//       : await fs.copyFile(srcPath, destPath);
//   }
// }

// copyDir(content, root);

// fs.copyFile(src, dest, mode, callback);
// fs.copyFileSync(content, root);

// try {
//   fs.writeFileSync(
//     path.join("**", root, {
//       parents: true,
//       cwd: path.join(process.cwd(), "templates"),
//     })
//   );
//   //file written successfully
// } catch (err) {
//   console.error(err);
// }

// const child_process = require("child_process");

// child_process.spawn("**", root, {
//   cwd: path.join(process.cwd(), "templates"),
//   detached: false,
//   stdio: "inherit",
// });

// const template = typescript ? "typescript" : "default";

// const template = "default";

// console.log(__dirname);
// console.log(process.cwd());

// await cpy("**", root, {
//   parents: true,
//   cwd: path.join(process.cwd(), "templates"),
//   // rename: (name) => {
//   //   switch (name) {
//   //     case "gitignore":
//   //     case "eslintrc.json": {
//   //       return ".".concat(name);
//   //     }
//   //     // README.md is ignored by webpack-asset-relocator-loader used by ncc:
//   //     // https://github.com/vercel/webpack-asset-relocator-loader/blob/e9308683d47ff507253e37c9bcbb99474603192b/src/asset-relocator.js#L227
//   //     case "README-template.md": {
//   //       return "README.md";
//   //     }
//   //     default: {
//   //       return name;
//   //     }
//   //   }
//   // },
// });

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
