#!/usr/bin/env node
import { resolve } from "path";
import { existsSync, mkdirSync } from "fs";
const args = process.argv;

// const root = resolve(args[2]);
const root = resolve("somthing");

if (!existsSync(root)) {
  mkdirSync(root);
}

// import got from "got";
// import tar from "tar";
