#!/usr/bin/env node
module.exports = (() => {
  var e = {
    661: (e, r, t) => {
      t.r(r);
      const n = require("path");
      const i = require("fs");
      const _ = require("os");
      const o = "something";
      const u = {
        name: "app-name",
        private: true,
        scripts: {
          dev: "next dev",
          build: "next build",
          start: "next start",
          lint: "next lint",
        },
      };
      const a = () => {
        if (!i.existsSync(o)) {
          i.mkdirSync(o);
        }
        i.writeFileSync(
          n.join(o, "package.json"),
          JSON.stringify(u, null, 2) + _.EOL
        );
      };
      function run() {
        a();
      }
      run();
    },
  };
  var r = {};
  function __webpack_require__(t) {
    if (r[t]) {
      return r[t].exports;
    }
    var n = (r[t] = { exports: {} });
    var i = true;
    try {
      e[t](n, n.exports, __webpack_require__);
      i = false;
    } finally {
      if (i) delete r[t];
    }
    return n.exports;
  }
  (() => {
    __webpack_require__.r = (e) => {
      if (typeof Symbol !== "undefined" && Symbol.toStringTag) {
        Object.defineProperty(e, Symbol.toStringTag, { value: "Module" });
      }
      Object.defineProperty(e, "__esModule", { value: true });
    };
  })();
  __webpack_require__.ab = __dirname + "/";
  return __webpack_require__(661);
})();
