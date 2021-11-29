#!/usr/bin/env node
// const path = require("path");
// const fs = require("fs");
// const args = process.argv;

// const root = path.resolve(args[2]);

// if (!fs.existsSync(root)) {
//   fs.mkdirSync(root);
// }

import { resolve } from "path";
import { existsSync, mkdirSync } from "fs";
const args = process.argv;

const root = resolve(args[2]);

if (!existsSync(root)) {
  mkdirSync(root);
}

// import got from "got";
// import tar from "tar";
