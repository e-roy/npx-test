#!/usr/bin/env nodemodule.exports =
/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ 23:
/***/ ((__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) => {

// ESM COMPAT FLAG
__webpack_require__.r(__webpack_exports__);

// CONCATENATED MODULE: external "fs"
const external_fs_namespaceObject = require("fs");;
// CONCATENATED MODULE: ./index.js

/* eslint-disable import/no-extraneous-dependencies */

// import path from "path";
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
  if (!external_fs_namespaceObject.existsSync(root)) {
    external_fs_namespaceObject.mkdirSync(root);
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


/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		if(__webpack_module_cache__[moduleId]) {
/******/ 			return __webpack_module_cache__[moduleId].exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		var threw = true;
/******/ 		try {
/******/ 			__webpack_modules__[moduleId](module, module.exports, __webpack_require__);
/******/ 			threw = false;
/******/ 		} finally {
/******/ 			if(threw) delete __webpack_module_cache__[moduleId];
/******/ 		}
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/make namespace object */
/******/ 	(() => {
/******/ 		// define __esModule on exports
/******/ 		__webpack_require__.r = (exports) => {
/******/ 			if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
/******/ 				Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 			}
/******/ 			Object.defineProperty(exports, '__esModule', { value: true });
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/compat */
/******/ 	
/******/ 	__webpack_require__.ab = __dirname + "/";/************************************************************************/
/******/ 	// module exports must be returned from runtime so entry inlining is disabled
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	return __webpack_require__(23);
/******/ })()
;