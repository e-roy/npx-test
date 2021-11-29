#!/usr/bin/env node
import { resolve } from "path";
import { existsSync, mkdirSync } from "fs";
const args = process.argv;

const root = resolve(args[2]);

if (!existsSync(root)) {
  mkdirSync(root);
}

import download from "download-git-repo";

download("flippidippi/download-git-repo-fixture", "test/tmp", function (err) {
  console.log(err ? "Error" : "Success");
});

// import got from "got";
// import tar from "tar";
// import { Stream } from "stream";
// import { promisify } from "util";

// const pipeline = promisify(Stream.pipeline);

// function downloadAndExtractExample(){

//   return pipeline(
//     got.stream(
//       `https://codeload.github.com/${username}/${name}/tar.gz/${branch}`
//     ),
//     tar.extract(
//       { cwd: root, strip: filePath ? filePath.split("/").length + 1 : 1 },
//       [`${name}-${branch}${filePath ? `/${filePath}` : ""}`]
//     )
//   );
// }
