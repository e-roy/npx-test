#!/usr/bin/env nodeimport { createRequire as __WEBPACK_EXTERNAL_createRequire } from "module";
/******/ var __webpack_modules__ = ({

/***/ 7121:
/***/ ((module) => {



module.exports = asyncForEach;

/**
 * Simultaneously processes all items in the given array.
 *
 * @param {array} array - The array to iterate over
 * @param {function} iterator - The function to call for each item in the array
 * @param {function} done - The function to call when all iterators have completed
 */
function asyncForEach (array, iterator, done) {
  if (array.length === 0) {
    // NOTE: Normally a bad idea to mix sync and async, but it's safe here because
    // of the way that this method is currently used by DirectoryReader.
    done();
    return;
  }

  // Simultaneously process all items in the array.
  let pending = array.length;
  array.forEach(item => {
    iterator(item, () => {
      if (--pending === 0) {
        done();
      }
    });
  });
}


/***/ }),

/***/ 8147:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



module.exports = readdirAsync;

const maybe = __nccwpck_require__(9581);
const DirectoryReader = __nccwpck_require__(9270);

let asyncFacade = {
  fs: __nccwpck_require__(7147),
  forEach: __nccwpck_require__(7121),
  async: true
};

/**
 * Returns the buffered output from an asynchronous {@link DirectoryReader},
 * via an error-first callback or a {@link Promise}.
 *
 * @param {string} dir
 * @param {object} [options]
 * @param {function} [callback]
 * @param {object} internalOptions
 */
function readdirAsync (dir, options, callback, internalOptions) {
  if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }

  return maybe(callback, new Promise(((resolve, reject) => {
    let results = [];

    internalOptions.facade = asyncFacade;

    let reader = new DirectoryReader(dir, options, internalOptions);
    let stream = reader.stream;

    stream.on('error', err => {
      reject(err);
      stream.pause();
    });
    stream.on('data', result => {
      results.push(result);
    });
    stream.on('end', () => {
      resolve(results);
    });
  })));
}


/***/ }),

/***/ 6516:
/***/ ((module) => {



let call = module.exports = {
  safe: safeCall,
  once: callOnce,
};

/**
 * Calls a function with the given arguments, and ensures that the error-first callback is _always_
 * invoked exactly once, even if the function throws an error.
 *
 * @param {function} fn - The function to invoke
 * @param {...*} args - The arguments to pass to the function. The final argument must be a callback function.
 */
function safeCall (fn, args) {
  // Get the function arguments as an array
  args = Array.prototype.slice.call(arguments, 1);

  // Replace the callback function with a wrapper that ensures it will only be called once
  let callback = call.once(args.pop());
  args.push(callback);

  try {
    fn.apply(null, args);
  }
  catch (err) {
    callback(err);
  }
}

/**
 * Returns a wrapper function that ensures the given callback function is only called once.
 * Subsequent calls are ignored, unless the first argument is an Error, in which case the
 * error is thrown.
 *
 * @param {function} fn - The function that should only be called once
 * @returns {function}
 */
function callOnce (fn) {
  let fulfilled = false;

  return function onceWrapper (err) {
    if (!fulfilled) {
      fulfilled = true;
      return fn.apply(this, arguments);
    }
    else if (err) {
      // The callback has already been called, but now an error has occurred
      // (most likely inside the callback function). So re-throw the error,
      // so it gets handled further up the call stack
      throw err;
    }
  };
}


/***/ }),

/***/ 9270:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



const Readable = (__nccwpck_require__(2781).Readable);
const EventEmitter = (__nccwpck_require__(2361).EventEmitter);
const path = __nccwpck_require__(1017);
const normalizeOptions = __nccwpck_require__(2536);
const stat = __nccwpck_require__(9289);
const call = __nccwpck_require__(6516);

/**
 * Asynchronously reads the contents of a directory and streams the results
 * via a {@link stream.Readable}.
 */
class DirectoryReader {
  /**
   * @param {string} dir - The absolute or relative directory path to read
   * @param {object} [options] - User-specified options, if any (see {@link normalizeOptions})
   * @param {object} internalOptions - Internal options that aren't part of the public API
   * @class
   */
  constructor (dir, options, internalOptions) {
    this.options = options = normalizeOptions(options, internalOptions);

    // Indicates whether we should keep reading
    // This is set false if stream.Readable.push() returns false.
    this.shouldRead = true;

    // The directories to read
    // (initialized with the top-level directory)
    this.queue = [{
      path: dir,
      basePath: options.basePath,
      posixBasePath: options.posixBasePath,
      depth: 0
    }];

    // The number of directories that are currently being processed
    this.pending = 0;

    // The data that has been read, but not yet emitted
    this.buffer = [];

    this.stream = new Readable({ objectMode: true });
    this.stream._read = () => {
      // Start (or resume) reading
      this.shouldRead = true;

      // If we have data in the buffer, then send the next chunk
      if (this.buffer.length > 0) {
        this.pushFromBuffer();
      }

      // If we have directories queued, then start processing the next one
      if (this.queue.length > 0) {
        if (this.options.facade.sync) {
          while (this.queue.length > 0) {
            this.readNextDirectory();
          }
        }
        else {
          this.readNextDirectory();
        }
      }

      this.checkForEOF();
    };
  }

  /**
   * Reads the next directory in the queue
   */
  readNextDirectory () {
    let facade = this.options.facade;
    let dir = this.queue.shift();
    this.pending++;

    // Read the directory listing
    call.safe(facade.fs.readdir, dir.path, (err, items) => {
      if (err) {
        // fs.readdir threw an error
        this.emit('error', err);
        return this.finishedReadingDirectory();
      }

      try {
        // Process each item in the directory (simultaneously, if async)
        facade.forEach(
          items,
          this.processItem.bind(this, dir),
          this.finishedReadingDirectory.bind(this, dir)
        );
      }
      catch (err2) {
        // facade.forEach threw an error
        // (probably because fs.readdir returned an invalid result)
        this.emit('error', err2);
        this.finishedReadingDirectory();
      }
    });
  }

  /**
   * This method is called after all items in a directory have been processed.
   *
   * NOTE: This does not necessarily mean that the reader is finished, since there may still
   * be other directories queued or pending.
   */
  finishedReadingDirectory () {
    this.pending--;

    if (this.shouldRead) {
      // If we have directories queued, then start processing the next one
      if (this.queue.length > 0 && this.options.facade.async) {
        this.readNextDirectory();
      }

      this.checkForEOF();
    }
  }

  /**
   * Determines whether the reader has finished processing all items in all directories.
   * If so, then the "end" event is fired (via {@Readable#push})
   */
  checkForEOF () {
    if (this.buffer.length === 0 &&   // The stuff we've already read
    this.pending === 0 &&             // The stuff we're currently reading
    this.queue.length === 0) {        // The stuff we haven't read yet
      // There's no more stuff!
      this.stream.push(null);
    }
  }

  /**
   * Processes a single item in a directory.
   *
   * If the item is a directory, and `option.deep` is enabled, then the item will be added
   * to the directory queue.
   *
   * If the item meets the filter criteria, then it will be emitted to the reader's stream.
   *
   * @param {object} dir - A directory object from the queue
   * @param {string} item - The name of the item (name only, no path)
   * @param {function} done - A callback function that is called after the item has been processed
   */
  processItem (dir, item, done) {
    let stream = this.stream;
    let options = this.options;

    let itemPath = dir.basePath + item;
    let posixPath = dir.posixBasePath + item;
    let fullPath = path.join(dir.path, item);

    // If `options.deep` is a number, and we've already recursed to the max depth,
    // then there's no need to check fs.Stats to know if it's a directory.
    // If `options.deep` is a function, then we'll need fs.Stats
    let maxDepthReached = dir.depth >= options.recurseDepth;

    // Do we need to call `fs.stat`?
    let needStats =
      !maxDepthReached ||                                 // we need the fs.Stats to know if it's a directory
      options.stats ||                                    // the user wants fs.Stats objects returned
      options.recurseFn ||                                // we need fs.Stats for the recurse function
      options.filterFn ||                                 // we need fs.Stats for the filter function
      EventEmitter.listenerCount(stream, 'file') ||       // we need the fs.Stats to know if it's a file
      EventEmitter.listenerCount(stream, 'directory') ||  // we need the fs.Stats to know if it's a directory
      EventEmitter.listenerCount(stream, 'symlink');      // we need the fs.Stats to know if it's a symlink

    // If we don't need stats, then exit early
    if (!needStats) {
      if (this.filter(itemPath, posixPath)) {
        this.pushOrBuffer({ data: itemPath });
      }
      return done();
    }

    // Get the fs.Stats object for this path
    stat(options.facade.fs, fullPath, (err, stats) => {
      if (err) {
        // fs.stat threw an error
        this.emit('error', err);
        return done();
      }

      try {
        // Add the item's path to the fs.Stats object
        // The base of this path, and its separators are determined by the options
        // (i.e. options.basePath and options.sep)
        stats.path = itemPath;

        // Add depth of the path to the fs.Stats object for use this in the filter function
        stats.depth = dir.depth;

        if (this.shouldRecurse(stats, posixPath, maxDepthReached)) {
          // Add this subdirectory to the queue
          this.queue.push({
            path: fullPath,
            basePath: itemPath + options.sep,
            posixBasePath: posixPath + '/',
            depth: dir.depth + 1,
          });
        }

        // Determine whether this item matches the filter criteria
        if (this.filter(stats, posixPath)) {
          this.pushOrBuffer({
            data: options.stats ? stats : itemPath,
            file: stats.isFile(),
            directory: stats.isDirectory(),
            symlink: stats.isSymbolicLink(),
          });
        }

        done();
      }
      catch (err2) {
        // An error occurred while processing the item
        // (probably during a user-specified function, such as options.deep, options.filter, etc.)
        this.emit('error', err2);
        done();
      }
    });
  }

  /**
   * Pushes the given chunk of data to the stream, or adds it to the buffer,
   * depending on the state of the stream.
   *
   * @param {object} chunk
   */
  pushOrBuffer (chunk) {
    // Add the chunk to the buffer
    this.buffer.push(chunk);

    // If we're still reading, then immediately emit the next chunk in the buffer
    // (which may or may not be the chunk that we just added)
    if (this.shouldRead) {
      this.pushFromBuffer();
    }
  }

  /**
   * Immediately pushes the next chunk in the buffer to the reader's stream.
   * The "data" event will always be fired (via {@link Readable#push}).
   * In addition, the "file", "directory", and/or "symlink" events may be fired,
   * depending on the type of properties of the chunk.
   */
  pushFromBuffer () {
    let stream = this.stream;
    let chunk = this.buffer.shift();

    // Stream the data
    try {
      this.shouldRead = stream.push(chunk.data);
    }
    catch (err) {
      this.emit('error', err);
    }

    // Also emit specific events, based on the type of chunk
    chunk.file && this.emit('file', chunk.data);
    chunk.symlink && this.emit('symlink', chunk.data);
    chunk.directory && this.emit('directory', chunk.data);
  }

  /**
   * Determines whether the given directory meets the user-specified recursion criteria.
   * If the user didn't specify recursion criteria, then this function will default to true.
   *
   * @param {fs.Stats} stats - The directory's {@link fs.Stats} object
   * @param {string} posixPath - The item's POSIX path (used for glob matching)
   * @param {boolean} maxDepthReached - Whether we've already crawled the user-specified depth
   * @returns {boolean}
   */
  shouldRecurse (stats, posixPath, maxDepthReached) {
    let options = this.options;

    if (maxDepthReached) {
      // We've already crawled to the maximum depth. So no more recursion.
      return false;
    }
    else if (!stats.isDirectory()) {
      // It's not a directory. So don't try to crawl it.
      return false;
    }
    else if (options.recurseGlob) {
      // Glob patterns are always tested against the POSIX path, even on Windows
      // https://github.com/isaacs/node-glob#windows
      return options.recurseGlob.test(posixPath);
    }
    else if (options.recurseRegExp) {
      // Regular expressions are tested against the normal path
      // (based on the OS or options.sep)
      return options.recurseRegExp.test(stats.path);
    }
    else if (options.recurseFn) {
      try {
        // Run the user-specified recursion criteria
        return options.recurseFn.call(null, stats);
      }
      catch (err) {
        // An error occurred in the user's code.
        // In Sync and Async modes, this will return an error.
        // In Streaming mode, we emit an "error" event, but continue processing
        this.emit('error', err);
      }
    }
    else {
      // No recursion function was specified, and we're within the maximum depth.
      // So crawl this directory.
      return true;
    }
  }

  /**
   * Determines whether the given item meets the user-specified filter criteria.
   * If the user didn't specify a filter, then this function will always return true.
   *
   * @param {string|fs.Stats} value - Either the item's path, or the item's {@link fs.Stats} object
   * @param {string} posixPath - The item's POSIX path (used for glob matching)
   * @returns {boolean}
   */
  filter (value, posixPath) {
    let options = this.options;

    if (options.filterGlob) {
      // Glob patterns are always tested against the POSIX path, even on Windows
      // https://github.com/isaacs/node-glob#windows
      return options.filterGlob.test(posixPath);
    }
    else if (options.filterRegExp) {
      // Regular expressions are tested against the normal path
      // (based on the OS or options.sep)
      return options.filterRegExp.test(value.path || value);
    }
    else if (options.filterFn) {
      try {
        // Run the user-specified filter function
        return options.filterFn.call(null, value);
      }
      catch (err) {
        // An error occurred in the user's code.
        // In Sync and Async modes, this will return an error.
        // In Streaming mode, we emit an "error" event, but continue processing
        this.emit('error', err);
      }
    }
    else {
      // No filter was specified, so match everything
      return true;
    }
  }

  /**
   * Emits an event.  If one of the event listeners throws an error,
   * then an "error" event is emitted.
   *
   * @param {string} eventName
   * @param {*} data
   */
  emit (eventName, data) {
    let stream = this.stream;

    try {
      stream.emit(eventName, data);
    }
    catch (err) {
      if (eventName === 'error') {
        // Don't recursively emit "error" events.
        // If the first one fails, then just throw
        throw err;
      }
      else {
        stream.emit('error', err);
      }
    }
  }
}

module.exports = DirectoryReader;


/***/ }),

/***/ 9913:
/***/ ((module, exports, __nccwpck_require__) => {



const readdirSync = __nccwpck_require__(9638);
const readdirAsync = __nccwpck_require__(8147);
const readdirStream = __nccwpck_require__(6453);

module.exports = exports = readdirAsyncPath;
exports.readdir = exports.readdirAsync = exports.async = readdirAsyncPath;
exports.readdirAsyncStat = exports.async.stat = readdirAsyncStat;
exports.readdirStream = exports.stream = readdirStreamPath;
exports.readdirStreamStat = exports.stream.stat = readdirStreamStat;
exports.readdirSync = exports.sync = readdirSyncPath;
exports.readdirSyncStat = exports.sync.stat = readdirSyncStat;

/**
 * Synchronous readdir that returns an array of string paths.
 *
 * @param {string} dir
 * @param {object} [options]
 * @returns {string[]}
 */
function readdirSyncPath (dir, options) {
  return readdirSync(dir, options, {});
}

/**
 * Synchronous readdir that returns results as an array of {@link fs.Stats} objects
 *
 * @param {string} dir
 * @param {object} [options]
 * @returns {fs.Stats[]}
 */
function readdirSyncStat (dir, options) {
  return readdirSync(dir, options, { stats: true });
}

/**
 * Aynchronous readdir (accepts an error-first callback or returns a {@link Promise}).
 * Results are an array of path strings.
 *
 * @param {string} dir
 * @param {object} [options]
 * @param {function} [callback]
 * @returns {Promise<string[]>}
 */
function readdirAsyncPath (dir, options, callback) {
  return readdirAsync(dir, options, callback, {});
}

/**
 * Aynchronous readdir (accepts an error-first callback or returns a {@link Promise}).
 * Results are an array of {@link fs.Stats} objects.
 *
 * @param {string} dir
 * @param {object} [options]
 * @param {function} [callback]
 * @returns {Promise<fs.Stats[]>}
 */
function readdirAsyncStat (dir, options, callback) {
  return readdirAsync(dir, options, callback, { stats: true });
}

/**
 * Aynchronous readdir that returns a {@link stream.Readable} (which is also an {@link EventEmitter}).
 * All stream data events ("data", "file", "directory", "symlink") are passed a path string.
 *
 * @param {string} dir
 * @param {object} [options]
 * @returns {stream.Readable}
 */
function readdirStreamPath (dir, options) {
  return readdirStream(dir, options, {});
}

/**
 * Aynchronous readdir that returns a {@link stream.Readable} (which is also an {@link EventEmitter})
 * All stream data events ("data", "file", "directory", "symlink") are passed an {@link fs.Stats} object.
 *
 * @param {string} dir
 * @param {object} [options]
 * @returns {stream.Readable}
 */
function readdirStreamStat (dir, options) {
  return readdirStream(dir, options, { stats: true });
}


/***/ }),

/***/ 2536:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



const path = __nccwpck_require__(1017);
const globToRegExp = __nccwpck_require__(7117);

module.exports = normalizeOptions;

let isWindows = /^win/.test(process.platform);

/**
 * @typedef {Object} FSFacade
 * @property {fs.readdir} readdir
 * @property {fs.stat} stat
 * @property {fs.lstat} lstat
 */

/**
 * Validates and normalizes the options argument
 *
 * @param {object} [options] - User-specified options, if any
 * @param {object} internalOptions - Internal options that aren't part of the public API
 *
 * @param {number|boolean|function} [options.deep]
 * The number of directories to recursively traverse. Any falsy value or negative number will
 * default to zero, so only the top-level contents will be returned. Set to `true` or `Infinity`
 * to traverse all subdirectories.  Or provide a function that accepts a {@link fs.Stats} object
 * and returns a truthy value if the directory's contents should be crawled.
 *
 * @param {function|string|RegExp} [options.filter]
 * A function that accepts a {@link fs.Stats} object and returns a truthy value if the data should
 * be returned.  Or a RegExp or glob string pattern, to filter by file name.
 *
 * @param {string} [options.sep]
 * The path separator to use. By default, the OS-specific separator will be used, but this can be
 * set to a specific value to ensure consistency across platforms.
 *
 * @param {string} [options.basePath]
 * The base path to prepend to each result. If empty, then all results will be relative to `dir`.
 *
 * @param {FSFacade} [options.fs]
 * Synchronous or asynchronous facades for Node.js File System module
 *
 * @param {object} [internalOptions.facade]
 * Synchronous or asynchronous facades for various methods, including for the Node.js File System module
 *
 * @param {boolean} [internalOptions.emit]
 * Indicates whether the reader should emit "file", "directory", and "symlink" events
 *
 * @param {boolean} [internalOptions.stats]
 * Indicates whether the reader should emit {@link fs.Stats} objects instead of path strings
 *
 * @returns {object}
 */
function normalizeOptions (options, internalOptions) {
  if (options === null || options === undefined) {
    options = {};
  }
  else if (typeof options !== 'object') {
    throw new TypeError('options must be an object');
  }

  let recurseDepth, recurseFn, recurseRegExp, recurseGlob, deep = options.deep;
  if (deep === null || deep === undefined) {
    recurseDepth = 0;
  }
  else if (typeof deep === 'boolean') {
    recurseDepth = deep ? Infinity : 0;
  }
  else if (typeof deep === 'number') {
    if (deep < 0 || isNaN(deep)) {
      throw new Error('options.deep must be a positive number');
    }
    else if (Math.floor(deep) !== deep) {
      throw new Error('options.deep must be an integer');
    }
    else {
      recurseDepth = deep;
    }
  }
  else if (typeof deep === 'function') {
    recurseDepth = Infinity;
    recurseFn = deep;
  }
  else if (deep instanceof RegExp) {
    recurseDepth = Infinity;
    recurseRegExp = deep;
  }
  else if (typeof deep === 'string' && deep.length > 0) {
    recurseDepth = Infinity;
    recurseGlob = globToRegExp(deep, { extended: true, globstar: true });
  }
  else {
    throw new TypeError('options.deep must be a boolean, number, function, regular expression, or glob pattern');
  }

  let filterFn, filterRegExp, filterGlob, filter = options.filter;
  if (filter !== null && filter !== undefined) {
    if (typeof filter === 'function') {
      filterFn = filter;
    }
    else if (filter instanceof RegExp) {
      filterRegExp = filter;
    }
    else if (typeof filter === 'string' && filter.length > 0) {
      filterGlob = globToRegExp(filter, { extended: true, globstar: true });
    }
    else {
      throw new TypeError('options.filter must be a function, regular expression, or glob pattern');
    }
  }

  let sep = options.sep;
  if (sep === null || sep === undefined) {
    sep = path.sep;
  }
  else if (typeof sep !== 'string') {
    throw new TypeError('options.sep must be a string');
  }

  let basePath = options.basePath;
  if (basePath === null || basePath === undefined) {
    basePath = '';
  }
  else if (typeof basePath === 'string') {
    // Append a path separator to the basePath, if necessary
    if (basePath && basePath.substr(-1) !== sep) {
      basePath += sep;
    }
  }
  else {
    throw new TypeError('options.basePath must be a string');
  }

  // Convert the basePath to POSIX (forward slashes)
  // so that glob pattern matching works consistently, even on Windows
  let posixBasePath = basePath;
  if (posixBasePath && sep !== '/') {
    posixBasePath = posixBasePath.replace(new RegExp('\\' + sep, 'g'), '/');

    /* istanbul ignore if */
    if (isWindows) {
      // Convert Windows root paths (C:\) and UNCs (\\) to POSIX root paths
      posixBasePath = posixBasePath.replace(/^([a-zA-Z]\:\/|\/\/)/, '/');
    }
  }

  // Determine which facade methods to use
  let facade;
  if (options.fs === null || options.fs === undefined) {
    // The user didn't provide their own facades, so use our internal ones
    facade = internalOptions.facade;
  }
  else if (typeof options.fs === 'object') {
    // Merge the internal facade methods with the user-provided `fs` facades
    facade = Object.assign({}, internalOptions.facade);
    facade.fs = Object.assign({}, internalOptions.facade.fs, options.fs);
  }
  else {
    throw new TypeError('options.fs must be an object');
  }

  return {
    recurseDepth,
    recurseFn,
    recurseRegExp,
    recurseGlob,
    filterFn,
    filterRegExp,
    filterGlob,
    sep,
    basePath,
    posixBasePath,
    facade,
    emit: !!internalOptions.emit,
    stats: !!internalOptions.stats,
  };
}


/***/ }),

/***/ 9289:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



const call = __nccwpck_require__(6516);

module.exports = stat;

/**
 * Retrieves the {@link fs.Stats} for the given path. If the path is a symbolic link,
 * then the Stats of the symlink's target are returned instead.  If the symlink is broken,
 * then the Stats of the symlink itself are returned.
 *
 * @param {object} fs - Synchronous or Asynchronouse facade for the "fs" module
 * @param {string} path - The path to return stats for
 * @param {function} callback
 */
function stat (fs, path, callback) {
  let isSymLink = false;

  call.safe(fs.lstat, path, (err, lstats) => {
    if (err) {
      // fs.lstat threw an eror
      return callback(err);
    }

    try {
      isSymLink = lstats.isSymbolicLink();
    }
    catch (err2) {
      // lstats.isSymbolicLink() threw an error
      // (probably because fs.lstat returned an invalid result)
      return callback(err2);
    }

    if (isSymLink) {
      // Try to resolve the symlink
      symlinkStat(fs, path, lstats, callback);
    }
    else {
      // It's not a symlink, so return the stats as-is
      callback(null, lstats);
    }
  });
}

/**
 * Retrieves the {@link fs.Stats} for the target of the given symlink.
 * If the symlink is broken, then the Stats of the symlink itself are returned.
 *
 * @param {object} fs - Synchronous or Asynchronouse facade for the "fs" module
 * @param {string} path - The path of the symlink to return stats for
 * @param {object} lstats - The stats of the symlink
 * @param {function} callback
 */
function symlinkStat (fs, path, lstats, callback) {
  call.safe(fs.stat, path, (err, stats) => {
    if (err) {
      // The symlink is broken, so return the stats for the link itself
      return callback(null, lstats);
    }

    try {
      // Return the stats for the resolved symlink target,
      // and override the `isSymbolicLink` method to indicate that it's a symlink
      stats.isSymbolicLink = () => true;
    }
    catch (err2) {
      // Setting stats.isSymbolicLink threw an error
      // (probably because fs.stat returned an invalid result)
      return callback(err2);
    }

    callback(null, stats);
  });
}


/***/ }),

/***/ 6453:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



module.exports = readdirStream;

const DirectoryReader = __nccwpck_require__(9270);

let streamFacade = {
  fs: __nccwpck_require__(7147),
  forEach: __nccwpck_require__(7121),
  async: true
};

/**
 * Returns the {@link stream.Readable} of an asynchronous {@link DirectoryReader}.
 *
 * @param {string} dir
 * @param {object} [options]
 * @param {object} internalOptions
 */
function readdirStream (dir, options, internalOptions) {
  internalOptions.facade = streamFacade;

  let reader = new DirectoryReader(dir, options, internalOptions);
  return reader.stream;
}


/***/ }),

/***/ 8220:
/***/ ((module) => {



module.exports = syncForEach;

/**
 * A facade that allows {@link Array.forEach} to be called as though it were asynchronous.
 *
 * @param {array} array - The array to iterate over
 * @param {function} iterator - The function to call for each item in the array
 * @param {function} done - The function to call when all iterators have completed
 */
function syncForEach (array, iterator, done) {
  array.forEach(item => {
    iterator(item, () => {
      // Note: No error-handling here because this is currently only ever called
      // by DirectoryReader, which never passes an `error` parameter to the callback.
      // Instead, DirectoryReader emits an "error" event if an error occurs.
    });
  });

  done();
}


/***/ }),

/***/ 6117:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {



const fs = __nccwpck_require__(7147);
const call = __nccwpck_require__(6516);

/**
 * A facade around {@link fs.readdirSync} that allows it to be called
 * the same way as {@link fs.readdir}.
 *
 * @param {string} dir
 * @param {function} callback
 */
exports.readdir = function (dir, callback) {
  // Make sure the callback is only called once
  callback = call.once(callback);

  try {
    let items = fs.readdirSync(dir);
    callback(null, items);
  }
  catch (err) {
    callback(err);
  }
};

/**
 * A facade around {@link fs.statSync} that allows it to be called
 * the same way as {@link fs.stat}.
 *
 * @param {string} path
 * @param {function} callback
 */
exports.stat = function (path, callback) {
  // Make sure the callback is only called once
  callback = call.once(callback);

  try {
    let stats = fs.statSync(path);
    callback(null, stats);
  }
  catch (err) {
    callback(err);
  }
};

/**
 * A facade around {@link fs.lstatSync} that allows it to be called
 * the same way as {@link fs.lstat}.
 *
 * @param {string} path
 * @param {function} callback
 */
exports.lstat = function (path, callback) {
  // Make sure the callback is only called once
  callback = call.once(callback);

  try {
    let stats = fs.lstatSync(path);
    callback(null, stats);
  }
  catch (err) {
    callback(err);
  }
};


/***/ }),

/***/ 9638:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



module.exports = readdirSync;

const DirectoryReader = __nccwpck_require__(9270);

let syncFacade = {
  fs: __nccwpck_require__(6117),
  forEach: __nccwpck_require__(8220),
  sync: true
};

/**
 * Returns the buffered output from a synchronous {@link DirectoryReader}.
 *
 * @param {string} dir
 * @param {object} [options]
 * @param {object} internalOptions
 */
function readdirSync (dir, options, internalOptions) {
  internalOptions.facade = syncFacade;

  let reader = new DirectoryReader(dir, options, internalOptions);
  let stream = reader.stream;

  let results = [];
  let data = stream.read();
  while (data !== null) {
    results.push(data);
    data = stream.read();
  }

  return results;
}


/***/ }),

/***/ 2987:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
const fs = __nccwpck_require__(7147);
exports.FILE_SYSTEM_ADAPTER = {
    lstat: fs.lstat,
    stat: fs.stat,
    lstatSync: fs.lstatSync,
    statSync: fs.statSync
};
function getFileSystemAdapter(fsMethods) {
    if (!fsMethods) {
        return exports.FILE_SYSTEM_ADAPTER;
    }
    return Object.assign({}, exports.FILE_SYSTEM_ADAPTER, fsMethods);
}
exports.getFileSystemAdapter = getFileSystemAdapter;


/***/ }),

/***/ 109:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
const optionsManager = __nccwpck_require__(8018);
const statProvider = __nccwpck_require__(709);
/**
 * Asynchronous API.
 */
function stat(path, opts) {
    return new Promise((resolve, reject) => {
        statProvider.async(path, optionsManager.prepare(opts), (err, stats) => err ? reject(err) : resolve(stats));
    });
}
exports.stat = stat;
function statCallback(path, optsOrCallback, callback) {
    if (typeof optsOrCallback === 'function') {
        callback = optsOrCallback; /* tslint:disable-line: no-parameter-reassignment */
        optsOrCallback = undefined; /* tslint:disable-line: no-parameter-reassignment */
    }
    if (typeof callback === 'undefined') {
        throw new TypeError('The "callback" argument must be of type Function.');
    }
    statProvider.async(path, optionsManager.prepare(optsOrCallback), callback);
}
exports.statCallback = statCallback;
/**
 * Synchronous API.
 */
function statSync(path, opts) {
    return statProvider.sync(path, optionsManager.prepare(opts));
}
exports.statSync = statSync;


/***/ }),

/***/ 8018:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
const fsAdapter = __nccwpck_require__(2987);
function prepare(opts) {
    const options = Object.assign({
        fs: fsAdapter.getFileSystemAdapter(opts ? opts.fs : undefined),
        throwErrorOnBrokenSymlinks: true,
        followSymlinks: true
    }, opts);
    return options;
}
exports.prepare = prepare;


/***/ }),

/***/ 709:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
function sync(path, options) {
    const lstat = options.fs.lstatSync(path);
    if (!isFollowedSymlink(lstat, options)) {
        return lstat;
    }
    try {
        const stat = options.fs.statSync(path);
        stat.isSymbolicLink = () => true;
        return stat;
    }
    catch (err) {
        if (!options.throwErrorOnBrokenSymlinks) {
            return lstat;
        }
        throw err;
    }
}
exports.sync = sync;
function async(path, options, callback) {
    options.fs.lstat(path, (err0, lstat) => {
        if (err0) {
            return callback(err0, undefined);
        }
        if (!isFollowedSymlink(lstat, options)) {
            return callback(null, lstat);
        }
        options.fs.stat(path, (err1, stat) => {
            if (err1) {
                return options.throwErrorOnBrokenSymlinks ? callback(err1) : callback(null, lstat);
            }
            stat.isSymbolicLink = () => true;
            callback(null, stat);
        });
    });
}
exports.async = async;
/**
 * Returns `true` for followed symlink.
 */
function isFollowedSymlink(stat, options) {
    return stat.isSymbolicLink() && options.followSymlinks;
}
exports.isFollowedSymlink = isFollowedSymlink;


/***/ }),

/***/ 1231:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {


const indentString = __nccwpck_require__(8043);
const cleanStack = __nccwpck_require__(7972);

const cleanInternalStack = stack => stack.replace(/\s+at .*aggregate-error\/index.js:\d+:\d+\)?/g, '');

class AggregateError extends Error {
	constructor(errors) {
		if (!Array.isArray(errors)) {
			throw new TypeError(`Expected input to be an Array, got ${typeof errors}`);
		}

		errors = [...errors].map(error => {
			if (error instanceof Error) {
				return error;
			}

			if (error !== null && typeof error === 'object') {
				// Handle plain error objects with message property and/or possibly other metadata
				return Object.assign(new Error(error.message), error);
			}

			return new Error(error);
		});

		let message = errors
			.map(error => {
				// The `stack` property is not standardized, so we can't assume it exists
				return typeof error.stack === 'string' ? cleanInternalStack(cleanStack(error.stack)) : String(error);
			})
			.join('\n');
		message = '\n' + indentString(message, 4);
		super(message);

		this.name = 'AggregateError';

		Object.defineProperty(this, '_errors', {value: errors});
	}

	* [Symbol.iterator]() {
		for (const error of this._errors) {
			yield error;
		}
	}
}

module.exports = AggregateError;


/***/ }),

/***/ 8915:
/***/ ((module) => {

/*!
 * arr-diff <https://github.com/jonschlinkert/arr-diff>
 *
 * Copyright (c) 2014-2017, Jon Schlinkert.
 * Released under the MIT License.
 */



module.exports = function diff(arr/*, arrays*/) {
  var len = arguments.length;
  var idx = 0;
  while (++idx < len) {
    arr = diffArray(arr, arguments[idx]);
  }
  return arr;
};

function diffArray(one, two) {
  if (!Array.isArray(two)) {
    return one.slice();
  }

  var tlen = two.length
  var olen = one.length;
  var idx = -1;
  var arr = [];

  while (++idx < olen) {
    var ele = one[idx];

    var hasEle = false;
    for (var i = 0; i < tlen; i++) {
      var val = two[i];

      if (ele === val) {
        hasEle = true;
        break;
      }
    }

    if (hasEle === false) {
      arr.push(ele);
    }
  }
  return arr;
}


/***/ }),

/***/ 7493:
/***/ ((module) => {

/*!
 * arr-flatten <https://github.com/jonschlinkert/arr-flatten>
 *
 * Copyright (c) 2014-2017, Jon Schlinkert.
 * Released under the MIT License.
 */



module.exports = function (arr) {
  return flat(arr, []);
};

function flat(arr, res) {
  var i = 0, cur;
  var len = arr.length;
  for (; i < len; i++) {
    cur = arr[i];
    Array.isArray(cur) ? flat(cur, res) : res.push(cur);
  }
  return res;
}


/***/ }),

/***/ 8815:
/***/ ((module) => {



module.exports = function union(init) {
  if (!Array.isArray(init)) {
    throw new TypeError('arr-union expects the first argument to be an array.');
  }

  var len = arguments.length;
  var i = 0;

  while (++i < len) {
    var arg = arguments[i];
    if (!arg) continue;

    if (!Array.isArray(arg)) {
      arg = [arg];
    }

    for (var j = 0; j < arg.length; j++) {
      var ele = arg[j];

      if (init.indexOf(ele) >= 0) {
        continue;
      }
      init.push(ele);
    }
  }
  return init;
};


/***/ }),

/***/ 9600:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {


var arrayUniq = __nccwpck_require__(1530);

module.exports = function () {
	return arrayUniq([].concat.apply([], arguments));
};


/***/ }),

/***/ 1530:
/***/ ((module) => {



// there's 3 implementations written in increasing order of efficiency

// 1 - no Set type is defined
function uniqNoSet(arr) {
	var ret = [];

	for (var i = 0; i < arr.length; i++) {
		if (ret.indexOf(arr[i]) === -1) {
			ret.push(arr[i]);
		}
	}

	return ret;
}

// 2 - a simple Set type is defined
function uniqSet(arr) {
	var seen = new Set();
	return arr.filter(function (el) {
		if (!seen.has(el)) {
			seen.add(el);
			return true;
		}

		return false;
	});
}

// 3 - a standard Set type is defined and it has a forEach method
function uniqSetWithForEach(arr) {
	var ret = [];

	(new Set(arr)).forEach(function (el) {
		ret.push(el);
	});

	return ret;
}

// V8 currently has a broken implementation
// https://github.com/joyent/node/issues/8449
function doesForEachActuallyWork() {
	var ret = false;

	(new Set([true])).forEach(function (el) {
		ret = el;
	});

	return ret === true;
}

if ('Set' in global) {
	if (typeof Set.prototype.forEach === 'function' && doesForEachActuallyWork()) {
		module.exports = uniqSetWithForEach;
	} else {
		module.exports = uniqSet;
	}
} else {
	module.exports = uniqNoSet;
}


/***/ }),

/***/ 340:
/***/ ((module) => {

/*!
 * array-unique <https://github.com/jonschlinkert/array-unique>
 *
 * Copyright (c) 2014-2015, Jon Schlinkert.
 * Licensed under the MIT License.
 */



module.exports = function unique(arr) {
  if (!Array.isArray(arr)) {
    throw new TypeError('array-unique expects an array.');
  }

  var len = arr.length;
  var i = -1;

  while (i++ < len) {
    var j = i + 1;

    for (; j < arr.length; ++j) {
      if (arr[i] === arr[j]) {
        arr.splice(j--, 1);
      }
    }
  }
  return arr;
};

module.exports.immutable = function uniqueImmutable(arr) {
  if (!Array.isArray(arr)) {
    throw new TypeError('array-unique expects an array.');
  }

  var arrLen = arr.length;
  var newArr = new Array(arrLen);

  for (var i = 0; i < arrLen; i++) {
    newArr[i] = arr[i];
  }

  return module.exports(newArr);
};


/***/ }),

/***/ 1546:
/***/ ((module) => {



const arrify = value => {
	if (value === null || value === undefined) {
		return [];
	}

	if (Array.isArray(value)) {
		return value;
	}

	if (typeof value === 'string') {
		return [value];
	}

	if (typeof value[Symbol.iterator] === 'function') {
		return [...value];
	}

	return [value];
};

module.exports = arrify;


/***/ }),

/***/ 8782:
/***/ ((module) => {

/*!
 * assign-symbols <https://github.com/jonschlinkert/assign-symbols>
 *
 * Copyright (c) 2015, Jon Schlinkert.
 * Licensed under the MIT License.
 */



module.exports = function(receiver, objects) {
  if (receiver === null || typeof receiver === 'undefined') {
    throw new TypeError('expected first argument to be an object.');
  }

  if (typeof objects === 'undefined' || typeof Symbol === 'undefined') {
    return receiver;
  }

  if (typeof Object.getOwnPropertySymbols !== 'function') {
    return receiver;
  }

  var isEnumerable = Object.prototype.propertyIsEnumerable;
  var target = Object(receiver);
  var len = arguments.length, i = 0;

  while (++i < len) {
    var provider = Object(arguments[i]);
    var names = Object.getOwnPropertySymbols(provider);

    for (var j = 0; j < names.length; j++) {
      var key = names[j];

      if (isEnumerable.call(provider, key)) {
        target[key] = provider[key];
      }
    }
  }
  return target;
};


/***/ }),

/***/ 161:
/***/ ((module) => {



function atob(str) {
  return Buffer.from(str, 'base64').toString('binary');
}

module.exports = atob.atob = atob;


/***/ }),

/***/ 9417:
/***/ ((module) => {


module.exports = balanced;
function balanced(a, b, str) {
  if (a instanceof RegExp) a = maybeMatch(a, str);
  if (b instanceof RegExp) b = maybeMatch(b, str);

  var r = range(a, b, str);

  return r && {
    start: r[0],
    end: r[1],
    pre: str.slice(0, r[0]),
    body: str.slice(r[0] + a.length, r[1]),
    post: str.slice(r[1] + b.length)
  };
}

function maybeMatch(reg, str) {
  var m = str.match(reg);
  return m ? m[0] : null;
}

balanced.range = range;
function range(a, b, str) {
  var begs, beg, left, right, result;
  var ai = str.indexOf(a);
  var bi = str.indexOf(b, ai + 1);
  var i = ai;

  if (ai >= 0 && bi > 0) {
    if(a===b) {
      return [ai, bi];
    }
    begs = [];
    left = str.length;

    while (i >= 0 && !result) {
      if (i == ai) {
        begs.push(i);
        ai = str.indexOf(a, i + 1);
      } else if (begs.length == 1) {
        result = [ begs.pop(), bi ];
      } else {
        beg = begs.pop();
        if (beg < left) {
          left = beg;
          right = bi;
        }

        bi = str.indexOf(b, i + 1);
      }

      i = ai < bi && ai >= 0 ? ai : bi;
    }

    if (begs.length) {
      result = [ left, right ];
    }
  }

  return result;
}


/***/ }),

/***/ 842:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var util = __nccwpck_require__(3837);
var define = __nccwpck_require__(9780);
var CacheBase = __nccwpck_require__(4365);
var Emitter = __nccwpck_require__(6172);
var isObject = __nccwpck_require__(5509);
var merge = __nccwpck_require__(4540);
var pascal = __nccwpck_require__(198);
var cu = __nccwpck_require__(274);

/**
 * Optionally define a custom `cache` namespace to use.
 */

function namespace(name) {
  var Cache = name ? CacheBase.namespace(name) : CacheBase;
  var fns = [];

  /**
   * Create an instance of `Base` with the given `config` and `options`.
   *
   * ```js
   * // initialize with `config` and `options`
   * var app = new Base({isApp: true}, {abc: true});
   * app.set('foo', 'bar');
   *
   * // values defined with the given `config` object will be on the root of the instance
   * console.log(app.baz); //=> undefined
   * console.log(app.foo); //=> 'bar'
   * // or use `.get`
   * console.log(app.get('isApp')); //=> true
   * console.log(app.get('foo')); //=> 'bar'
   *
   * // values defined with the given `options` object will be on `app.options
   * console.log(app.options.abc); //=> true
   * ```
   *
   * @param {Object} `config` If supplied, this object is passed to [cache-base][] to merge onto the the instance upon instantiation.
   * @param {Object} `options` If supplied, this object is used to initialize the `base.options` object.
   * @api public
   */

  function Base(config, options) {
    if (!(this instanceof Base)) {
      return new Base(config, options);
    }
    Cache.call(this, config);
    this.is('base');
    this.initBase(config, options);
  }

  /**
   * Inherit cache-base
   */

  util.inherits(Base, Cache);

  /**
   * Add static emitter methods
   */

  Emitter(Base);

  /**
   * Initialize `Base` defaults with the given `config` object
   */

  Base.prototype.initBase = function(config, options) {
    this.options = merge({}, this.options, options);
    this.cache = this.cache || {};
    this.define('registered', {});
    if (name) this[name] = {};

    // make `app._callbacks` non-enumerable
    this.define('_callbacks', this._callbacks);
    if (isObject(config)) {
      this.visit('set', config);
    }
    Base.run(this, 'use', fns);
  };

  /**
   * Set the given `name` on `app._name` and `app.is*` properties. Used for doing
   * lookups in plugins.
   *
   * ```js
   * app.is('foo');
   * console.log(app._name);
   * //=> 'foo'
   * console.log(app.isFoo);
   * //=> true
   * app.is('bar');
   * console.log(app.isFoo);
   * //=> true
   * console.log(app.isBar);
   * //=> true
   * console.log(app._name);
   * //=> 'bar'
   * ```
   * @name .is
   * @param {String} `name`
   * @return {Boolean}
   * @api public
   */

  Base.prototype.is = function(name) {
    if (typeof name !== 'string') {
      throw new TypeError('expected name to be a string');
    }
    this.define('is' + pascal(name), true);
    this.define('_name', name);
    this.define('_appname', name);
    return this;
  };

  /**
   * Returns true if a plugin has already been registered on an instance.
   *
   * Plugin implementors are encouraged to use this first thing in a plugin
   * to prevent the plugin from being called more than once on the same
   * instance.
   *
   * ```js
   * var base = new Base();
   * base.use(function(app) {
   *   if (app.isRegistered('myPlugin')) return;
   *   // do stuff to `app`
   * });
   *
   * // to also record the plugin as being registered
   * base.use(function(app) {
   *   if (app.isRegistered('myPlugin', true)) return;
   *   // do stuff to `app`
   * });
   * ```
   * @name .isRegistered
   * @emits `plugin` Emits the name of the plugin being registered. Useful for unit tests, to ensure plugins are only registered once.
   * @param {String} `name` The plugin name.
   * @param {Boolean} `register` If the plugin if not already registered, to record it as being registered pass `true` as the second argument.
   * @return {Boolean} Returns true if a plugin is already registered.
   * @api public
   */

  Base.prototype.isRegistered = function(name, register) {
    if (this.registered.hasOwnProperty(name)) {
      return true;
    }
    if (register !== false) {
      this.registered[name] = true;
      this.emit('plugin', name);
    }
    return false;
  };

  /**
   * Define a plugin function to be called immediately upon init. Plugins are chainable
   * and expose the following arguments to the plugin function:
   *
   * - `app`: the current instance of `Base`
   * - `base`: the [first ancestor instance](#base) of `Base`
   *
   * ```js
   * var app = new Base()
   *   .use(foo)
   *   .use(bar)
   *   .use(baz)
   * ```
   * @name .use
   * @param {Function} `fn` plugin function to call
   * @return {Object} Returns the item instance for chaining.
   * @api public
   */

  Base.prototype.use = function(fn) {
    fn.call(this, this);
    return this;
  };

  /**
   * The `.define` method is used for adding non-enumerable property on the instance.
   * Dot-notation is **not supported** with `define`.
   *
   * ```js
   * // arbitrary `render` function using lodash `template`
   * app.define('render', function(str, locals) {
   *   return _.template(str)(locals);
   * });
   * ```
   * @name .define
   * @param {String} `key` The name of the property to define.
   * @param {any} `value`
   * @return {Object} Returns the instance for chaining.
   * @api public
   */

  Base.prototype.define = function(key, val) {
    if (isObject(key)) {
      return this.visit('define', key);
    }
    define(this, key, val);
    return this;
  };

  /**
   * Mix property `key` onto the Base prototype. If base is inherited using
   * `Base.extend` this method will be overridden by a new `mixin` method that will
   * only add properties to the prototype of the inheriting application.
   *
   * ```js
   * app.mixin('foo', function() {
   *   // do stuff
   * });
   * ```
   * @name .mixin
   * @param {String} `key`
   * @param {Object|Array} `val`
   * @return {Object} Returns the `base` instance for chaining.
   * @api public
   */

  Base.prototype.mixin = function(key, val) {
    Base.prototype[key] = val;
    return this;
  };

  /**
   * Non-enumberable mixin array, used by the static [Base.mixin]() method.
   */

  Base.prototype.mixins = Base.prototype.mixins || [];

  /**
   * Getter/setter used when creating nested instances of `Base`, for storing a reference
   * to the first ancestor instance. This works by setting an instance of `Base` on the `parent`
   * property of a "child" instance. The `base` property defaults to the current instance if
   * no `parent` property is defined.
   *
   * ```js
   * // create an instance of `Base`, this is our first ("base") instance
   * var first = new Base();
   * first.foo = 'bar'; // arbitrary property, to make it easier to see what's happening later
   *
   * // create another instance
   * var second = new Base();
   * // create a reference to the first instance (`first`)
   * second.parent = first;
   *
   * // create another instance
   * var third = new Base();
   * // create a reference to the previous instance (`second`)
   * // repeat this pattern every time a "child" instance is created
   * third.parent = second;
   *
   * // we can always access the first instance using the `base` property
   * console.log(first.base.foo);
   * //=> 'bar'
   * console.log(second.base.foo);
   * //=> 'bar'
   * console.log(third.base.foo);
   * //=> 'bar'
   * // and now you know how to get to third base ;)
   * ```
   * @name .base
   * @api public
   */

  Object.defineProperty(Base.prototype, 'base', {
    configurable: true,
    get: function() {
      return this.parent ? this.parent.base : this;
    }
  });

  /**
   * Static method for adding global plugin functions that will
   * be added to an instance when created.
   *
   * ```js
   * Base.use(function(app) {
   *   app.foo = 'bar';
   * });
   * var app = new Base();
   * console.log(app.foo);
   * //=> 'bar'
   * ```
   * @name #use
   * @param {Function} `fn` Plugin function to use on each instance.
   * @return {Object} Returns the `Base` constructor for chaining
   * @api public
   */

  define(Base, 'use', function(fn) {
    fns.push(fn);
    return Base;
  });

  /**
   * Run an array of functions by passing each function
   * to a method on the given object specified by the given property.
   *
   * @param  {Object} `obj` Object containing method to use.
   * @param  {String} `prop` Name of the method on the object to use.
   * @param  {Array} `arr` Array of functions to pass to the method.
   */

  define(Base, 'run', function(obj, prop, arr) {
    var len = arr.length, i = 0;
    while (len--) {
      obj[prop](arr[i++]);
    }
    return Base;
  });

  /**
   * Static method for inheriting the prototype and static methods of the `Base` class.
   * This method greatly simplifies the process of creating inheritance-based applications.
   * See [static-extend][] for more details.
   *
   * ```js
   * var extend = cu.extend(Parent);
   * Parent.extend(Child);
   *
   * // optional methods
   * Parent.extend(Child, {
   *   foo: function() {},
   *   bar: function() {}
   * });
   * ```
   * @name #extend
   * @param {Function} `Ctor` constructor to extend
   * @param {Object} `methods` Optional prototype properties to mix in.
   * @return {Object} Returns the `Base` constructor for chaining
   * @api public
   */

  define(Base, 'extend', cu.extend(Base, function(Ctor, Parent) {
    Ctor.prototype.mixins = Ctor.prototype.mixins || [];

    define(Ctor, 'mixin', function(fn) {
      var mixin = fn(Ctor.prototype, Ctor);
      if (typeof mixin === 'function') {
        Ctor.prototype.mixins.push(mixin);
      }
      return Ctor;
    });

    define(Ctor, 'mixins', function(Child) {
      Base.run(Child, 'mixin', Ctor.prototype.mixins);
      return Ctor;
    });

    Ctor.prototype.mixin = function(key, value) {
      Ctor.prototype[key] = value;
      return this;
    };
    return Base;
  }));

  /**
   * Used for adding methods to the `Base` prototype, and/or to the prototype of child instances.
   * When a mixin function returns a function, the returned function is pushed onto the `.mixins`
   * array, making it available to be used on inheriting classes whenever `Base.mixins()` is
   * called (e.g. `Base.mixins(Child)`).
   *
   * ```js
   * Base.mixin(function(proto) {
   *   proto.foo = function(msg) {
   *     return 'foo ' + msg;
   *   };
   * });
   * ```
   * @name #mixin
   * @param {Function} `fn` Function to call
   * @return {Object} Returns the `Base` constructor for chaining
   * @api public
   */

  define(Base, 'mixin', function(fn) {
    var mixin = fn(Base.prototype, Base);
    if (typeof mixin === 'function') {
      Base.prototype.mixins.push(mixin);
    }
    return Base;
  });

  /**
   * Static method for running global mixin functions against a child constructor.
   * Mixins must be registered before calling this method.
   *
   * ```js
   * Base.extend(Child);
   * Base.mixins(Child);
   * ```
   * @name #mixins
   * @param {Function} `Child` Constructor function of a child class
   * @return {Object} Returns the `Base` constructor for chaining
   * @api public
   */

  define(Base, 'mixins', function(Child) {
    Base.run(Child, 'mixin', Base.prototype.mixins);
    return Base;
  });

  /**
   * Similar to `util.inherit`, but copies all static properties, prototype properties, and
   * getters/setters from `Provider` to `Receiver`. See [class-utils][]{#inherit} for more details.
   *
   * ```js
   * Base.inherit(Foo, Bar);
   * ```
   * @name #inherit
   * @param {Function} `Receiver` Receiving (child) constructor
   * @param {Function} `Provider` Providing (parent) constructor
   * @return {Object} Returns the `Base` constructor for chaining
   * @api public
   */

  define(Base, 'inherit', cu.inherit);
  define(Base, 'bubble', cu.bubble);
  return Base;
}

/**
 * Expose `Base` with default settings
 */

module.exports = namespace();

/**
 * Allow users to define a namespace
 */

module.exports.namespace = namespace;


/***/ }),

/***/ 9780:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * define-property <https://github.com/jonschlinkert/define-property>
 *
 * Copyright (c) 2015, 2017, Jon Schlinkert.
 * Released under the MIT License.
 */



var isDescriptor = __nccwpck_require__(567);

module.exports = function defineProperty(obj, prop, val) {
  if (typeof obj !== 'object' && typeof obj !== 'function') {
    throw new TypeError('expected an object or function.');
  }

  if (typeof prop !== 'string') {
    throw new TypeError('expected `prop` to be a string.');
  }

  if (isDescriptor(val) && ('set' in val || 'get' in val)) {
    return Object.defineProperty(obj, prop, val);
  }

  return Object.defineProperty(obj, prop, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: val
  });
};


/***/ }),

/***/ 3717:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

var concatMap = __nccwpck_require__(6891);
var balanced = __nccwpck_require__(9417);

module.exports = expandTop;

var escSlash = '\0SLASH'+Math.random()+'\0';
var escOpen = '\0OPEN'+Math.random()+'\0';
var escClose = '\0CLOSE'+Math.random()+'\0';
var escComma = '\0COMMA'+Math.random()+'\0';
var escPeriod = '\0PERIOD'+Math.random()+'\0';

function numeric(str) {
  return parseInt(str, 10) == str
    ? parseInt(str, 10)
    : str.charCodeAt(0);
}

function escapeBraces(str) {
  return str.split('\\\\').join(escSlash)
            .split('\\{').join(escOpen)
            .split('\\}').join(escClose)
            .split('\\,').join(escComma)
            .split('\\.').join(escPeriod);
}

function unescapeBraces(str) {
  return str.split(escSlash).join('\\')
            .split(escOpen).join('{')
            .split(escClose).join('}')
            .split(escComma).join(',')
            .split(escPeriod).join('.');
}


// Basically just str.split(","), but handling cases
// where we have nested braced sections, which should be
// treated as individual members, like {a,{b,c},d}
function parseCommaParts(str) {
  if (!str)
    return [''];

  var parts = [];
  var m = balanced('{', '}', str);

  if (!m)
    return str.split(',');

  var pre = m.pre;
  var body = m.body;
  var post = m.post;
  var p = pre.split(',');

  p[p.length-1] += '{' + body + '}';
  var postParts = parseCommaParts(post);
  if (post.length) {
    p[p.length-1] += postParts.shift();
    p.push.apply(p, postParts);
  }

  parts.push.apply(parts, p);

  return parts;
}

function expandTop(str) {
  if (!str)
    return [];

  // I don't know why Bash 4.3 does this, but it does.
  // Anything starting with {} will have the first two bytes preserved
  // but *only* at the top level, so {},a}b will not expand to anything,
  // but a{},b}c will be expanded to [a}c,abc].
  // One could argue that this is a bug in Bash, but since the goal of
  // this module is to match Bash's rules, we escape a leading {}
  if (str.substr(0, 2) === '{}') {
    str = '\\{\\}' + str.substr(2);
  }

  return expand(escapeBraces(str), true).map(unescapeBraces);
}

function identity(e) {
  return e;
}

function embrace(str) {
  return '{' + str + '}';
}
function isPadded(el) {
  return /^-?0\d/.test(el);
}

function lte(i, y) {
  return i <= y;
}
function gte(i, y) {
  return i >= y;
}

function expand(str, isTop) {
  var expansions = [];

  var m = balanced('{', '}', str);
  if (!m || /\$$/.test(m.pre)) return [str];

  var isNumericSequence = /^-?\d+\.\.-?\d+(?:\.\.-?\d+)?$/.test(m.body);
  var isAlphaSequence = /^[a-zA-Z]\.\.[a-zA-Z](?:\.\.-?\d+)?$/.test(m.body);
  var isSequence = isNumericSequence || isAlphaSequence;
  var isOptions = m.body.indexOf(',') >= 0;
  if (!isSequence && !isOptions) {
    // {a},b}
    if (m.post.match(/,.*\}/)) {
      str = m.pre + '{' + m.body + escClose + m.post;
      return expand(str);
    }
    return [str];
  }

  var n;
  if (isSequence) {
    n = m.body.split(/\.\./);
  } else {
    n = parseCommaParts(m.body);
    if (n.length === 1) {
      // x{{a,b}}y ==> x{a}y x{b}y
      n = expand(n[0], false).map(embrace);
      if (n.length === 1) {
        var post = m.post.length
          ? expand(m.post, false)
          : [''];
        return post.map(function(p) {
          return m.pre + n[0] + p;
        });
      }
    }
  }

  // at this point, n is the parts, and we know it's not a comma set
  // with a single entry.

  // no need to expand pre, since it is guaranteed to be free of brace-sets
  var pre = m.pre;
  var post = m.post.length
    ? expand(m.post, false)
    : [''];

  var N;

  if (isSequence) {
    var x = numeric(n[0]);
    var y = numeric(n[1]);
    var width = Math.max(n[0].length, n[1].length)
    var incr = n.length == 3
      ? Math.abs(numeric(n[2]))
      : 1;
    var test = lte;
    var reverse = y < x;
    if (reverse) {
      incr *= -1;
      test = gte;
    }
    var pad = n.some(isPadded);

    N = [];

    for (var i = x; test(i, y); i += incr) {
      var c;
      if (isAlphaSequence) {
        c = String.fromCharCode(i);
        if (c === '\\')
          c = '';
      } else {
        c = String(i);
        if (pad) {
          var need = width - c.length;
          if (need > 0) {
            var z = new Array(need + 1).join('0');
            if (i < 0)
              c = '-' + z + c.slice(1);
            else
              c = z + c;
          }
        }
      }
      N.push(c);
    }
  } else {
    N = concatMap(n, function(el) { return expand(el, false) });
  }

  for (var j = 0; j < N.length; j++) {
    for (var k = 0; k < post.length; k++) {
      var expansion = pre + N[j] + post[k];
      if (!isTop || isSequence || expansion)
        expansions.push(expansion);
    }
  }

  return expansions;
}



/***/ }),

/***/ 610:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



/**
 * Module dependencies
 */

var toRegex = __nccwpck_require__(6855);
var unique = __nccwpck_require__(340);
var extend = __nccwpck_require__(7512);

/**
 * Local dependencies
 */

var compilers = __nccwpck_require__(7076);
var parsers = __nccwpck_require__(2829);
var Braces = __nccwpck_require__(7075);
var utils = __nccwpck_require__(5207);
var MAX_LENGTH = 1024 * 64;
var cache = {};

/**
 * Convert the given `braces` pattern into a regex-compatible string. By default, only one string is generated for every input string. Set `options.expand` to true to return an array of patterns (similar to Bash or minimatch. Before using `options.expand`, it's recommended that you read the [performance notes](#performance)).
 *
 * ```js
 * var braces = require('braces');
 * console.log(braces('{a,b,c}'));
 * //=> ['(a|b|c)']
 *
 * console.log(braces('{a,b,c}', {expand: true}));
 * //=> ['a', 'b', 'c']
 * ```
 * @param {String} `str`
 * @param {Object} `options`
 * @return {String}
 * @api public
 */

function braces(pattern, options) {
  var key = utils.createKey(String(pattern), options);
  var arr = [];

  var disabled = options && options.cache === false;
  if (!disabled && cache.hasOwnProperty(key)) {
    return cache[key];
  }

  if (Array.isArray(pattern)) {
    for (var i = 0; i < pattern.length; i++) {
      arr.push.apply(arr, braces.create(pattern[i], options));
    }
  } else {
    arr = braces.create(pattern, options);
  }

  if (options && options.nodupes === true) {
    arr = unique(arr);
  }

  if (!disabled) {
    cache[key] = arr;
  }
  return arr;
}

/**
 * Expands a brace pattern into an array. This method is called by the main [braces](#braces) function when `options.expand` is true. Before using this method it's recommended that you read the [performance notes](#performance)) and advantages of using [.optimize](#optimize) instead.
 *
 * ```js
 * var braces = require('braces');
 * console.log(braces.expand('a/{b,c}/d'));
 * //=> ['a/b/d', 'a/c/d'];
 * ```
 * @param {String} `pattern` Brace pattern
 * @param {Object} `options`
 * @return {Array} Returns an array of expanded values.
 * @api public
 */

braces.expand = function(pattern, options) {
  return braces.create(pattern, extend({}, options, {expand: true}));
};

/**
 * Expands a brace pattern into a regex-compatible, optimized string. This method is called by the main [braces](#braces) function by default.
 *
 * ```js
 * var braces = require('braces');
 * console.log(braces.expand('a/{b,c}/d'));
 * //=> ['a/(b|c)/d']
 * ```
 * @param {String} `pattern` Brace pattern
 * @param {Object} `options`
 * @return {Array} Returns an array of expanded values.
 * @api public
 */

braces.optimize = function(pattern, options) {
  return braces.create(pattern, options);
};

/**
 * Processes a brace pattern and returns either an expanded array (if `options.expand` is true), a highly optimized regex-compatible string. This method is called by the main [braces](#braces) function.
 *
 * ```js
 * var braces = require('braces');
 * console.log(braces.create('user-{200..300}/project-{a,b,c}-{1..10}'))
 * //=> 'user-(20[0-9]|2[1-9][0-9]|300)/project-(a|b|c)-([1-9]|10)'
 * ```
 * @param {String} `pattern` Brace pattern
 * @param {Object} `options`
 * @return {Array} Returns an array of expanded values.
 * @api public
 */

braces.create = function(pattern, options) {
  if (typeof pattern !== 'string') {
    throw new TypeError('expected a string');
  }

  var maxLength = (options && options.maxLength) || MAX_LENGTH;
  if (pattern.length >= maxLength) {
    throw new Error('expected pattern to be less than ' + maxLength + ' characters');
  }

  function create() {
    if (pattern === '' || pattern.length < 3) {
      return [pattern];
    }

    if (utils.isEmptySets(pattern)) {
      return [];
    }

    if (utils.isQuotedString(pattern)) {
      return [pattern.slice(1, -1)];
    }

    var proto = new Braces(options);
    var result = !options || options.expand !== true
      ? proto.optimize(pattern, options)
      : proto.expand(pattern, options);

    // get the generated pattern(s)
    var arr = result.output;

    // filter out empty strings if specified
    if (options && options.noempty === true) {
      arr = arr.filter(Boolean);
    }

    // filter out duplicates if specified
    if (options && options.nodupes === true) {
      arr = unique(arr);
    }

    Object.defineProperty(arr, 'result', {
      enumerable: false,
      value: result
    });

    return arr;
  }

  return memoize('create', pattern, options, create);
};

/**
 * Create a regular expression from the given string `pattern`.
 *
 * ```js
 * var braces = require('braces');
 *
 * console.log(braces.makeRe('id-{200..300}'));
 * //=> /^(?:id-(20[0-9]|2[1-9][0-9]|300))$/
 * ```
 * @param {String} `pattern` The pattern to convert to regex.
 * @param {Object} `options`
 * @return {RegExp}
 * @api public
 */

braces.makeRe = function(pattern, options) {
  if (typeof pattern !== 'string') {
    throw new TypeError('expected a string');
  }

  var maxLength = (options && options.maxLength) || MAX_LENGTH;
  if (pattern.length >= maxLength) {
    throw new Error('expected pattern to be less than ' + maxLength + ' characters');
  }

  function makeRe() {
    var arr = braces(pattern, options);
    var opts = extend({strictErrors: false}, options);
    return toRegex(arr, opts);
  }

  return memoize('makeRe', pattern, options, makeRe);
};

/**
 * Parse the given `str` with the given `options`.
 *
 * ```js
 * var braces = require('braces');
 * var ast = braces.parse('a/{b,c}/d');
 * console.log(ast);
 * // { type: 'root',
 * //   errors: [],
 * //   input: 'a/{b,c}/d',
 * //   nodes:
 * //    [ { type: 'bos', val: '' },
 * //      { type: 'text', val: 'a/' },
 * //      { type: 'brace',
 * //        nodes:
 * //         [ { type: 'brace.open', val: '{' },
 * //           { type: 'text', val: 'b,c' },
 * //           { type: 'brace.close', val: '}' } ] },
 * //      { type: 'text', val: '/d' },
 * //      { type: 'eos', val: '' } ] }
 * ```
 * @param {String} `pattern` Brace pattern to parse
 * @param {Object} `options`
 * @return {Object} Returns an AST
 * @api public
 */

braces.parse = function(pattern, options) {
  var proto = new Braces(options);
  return proto.parse(pattern, options);
};

/**
 * Compile the given `ast` or string with the given `options`.
 *
 * ```js
 * var braces = require('braces');
 * var ast = braces.parse('a/{b,c}/d');
 * console.log(braces.compile(ast));
 * // { options: { source: 'string' },
 * //   state: {},
 * //   compilers:
 * //    { eos: [Function],
 * //      noop: [Function],
 * //      bos: [Function],
 * //      brace: [Function],
 * //      'brace.open': [Function],
 * //      text: [Function],
 * //      'brace.close': [Function] },
 * //   output: [ 'a/(b|c)/d' ],
 * //   ast:
 * //    { ... },
 * //   parsingErrors: [] }
 * ```
 * @param {Object|String} `ast` AST from [.parse](#parse). If a string is passed it will be parsed first.
 * @param {Object} `options`
 * @return {Object} Returns an object that has an `output` property with the compiled string.
 * @api public
 */

braces.compile = function(ast, options) {
  var proto = new Braces(options);
  return proto.compile(ast, options);
};

/**
 * Clear the regex cache.
 *
 * ```js
 * braces.clearCache();
 * ```
 * @api public
 */

braces.clearCache = function() {
  cache = braces.cache = {};
};

/**
 * Memoize a generated regex or function. A unique key is generated
 * from the method name, pattern, and user-defined options. Set
 * options.memoize to false to disable.
 */

function memoize(type, pattern, options, fn) {
  var key = utils.createKey(type + ':' + pattern, options);
  var disabled = options && options.cache === false;
  if (disabled) {
    braces.clearCache();
    return fn(pattern, options);
  }

  if (cache.hasOwnProperty(key)) {
    return cache[key];
  }

  var res = fn(pattern, options);
  cache[key] = res;
  return res;
}

/**
 * Expose `Braces` constructor and methods
 * @type {Function}
 */

braces.Braces = Braces;
braces.compilers = compilers;
braces.parsers = parsers;
braces.cache = cache;

/**
 * Expose `braces`
 * @type {Function}
 */

module.exports = braces;


/***/ }),

/***/ 7075:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var extend = __nccwpck_require__(7512);
var Snapdragon = __nccwpck_require__(2403);
var compilers = __nccwpck_require__(7076);
var parsers = __nccwpck_require__(2829);
var utils = __nccwpck_require__(5207);

/**
 * Customize Snapdragon parser and renderer
 */

function Braces(options) {
  this.options = extend({}, options);
}

/**
 * Initialize braces
 */

Braces.prototype.init = function(options) {
  if (this.isInitialized) return;
  this.isInitialized = true;
  var opts = utils.createOptions({}, this.options, options);
  this.snapdragon = this.options.snapdragon || new Snapdragon(opts);
  this.compiler = this.snapdragon.compiler;
  this.parser = this.snapdragon.parser;

  compilers(this.snapdragon, opts);
  parsers(this.snapdragon, opts);

  /**
   * Call Snapdragon `.parse` method. When AST is returned, we check to
   * see if any unclosed braces are left on the stack and, if so, we iterate
   * over the stack and correct the AST so that compilers are called in the correct
   * order and unbalance braces are properly escaped.
   */

  utils.define(this.snapdragon, 'parse', function(pattern, options) {
    var parsed = Snapdragon.prototype.parse.apply(this, arguments);
    this.parser.ast.input = pattern;

    var stack = this.parser.stack;
    while (stack.length) {
      addParent({type: 'brace.close', val: ''}, stack.pop());
    }

    function addParent(node, parent) {
      utils.define(node, 'parent', parent);
      parent.nodes.push(node);
    }

    // add non-enumerable parser reference
    utils.define(parsed, 'parser', this.parser);
    return parsed;
  });
};

/**
 * Decorate `.parse` method
 */

Braces.prototype.parse = function(ast, options) {
  if (ast && typeof ast === 'object' && ast.nodes) return ast;
  this.init(options);
  return this.snapdragon.parse(ast, options);
};

/**
 * Decorate `.compile` method
 */

Braces.prototype.compile = function(ast, options) {
  if (typeof ast === 'string') {
    ast = this.parse(ast, options);
  } else {
    this.init(options);
  }
  return this.snapdragon.compile(ast, options);
};

/**
 * Expand
 */

Braces.prototype.expand = function(pattern) {
  var ast = this.parse(pattern, {expand: true});
  return this.compile(ast, {expand: true});
};

/**
 * Optimize
 */

Braces.prototype.optimize = function(pattern) {
  var ast = this.parse(pattern, {optimize: true});
  return this.compile(ast, {optimize: true});
};

/**
 * Expose `Braces`
 */

module.exports = Braces;


/***/ }),

/***/ 7076:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var utils = __nccwpck_require__(5207);

module.exports = function(braces, options) {
  braces.compiler

    /**
     * bos
     */

    .set('bos', function() {
      if (this.output) return;
      this.ast.queue = isEscaped(this.ast) ? [this.ast.val] : [];
      this.ast.count = 1;
    })

    /**
     * Square brackets
     */

    .set('bracket', function(node) {
      var close = node.close;
      var open = !node.escaped ? '[' : '\\[';
      var negated = node.negated;
      var inner = node.inner;

      inner = inner.replace(/\\(?=[\\\w]|$)/g, '\\\\');
      if (inner === ']-') {
        inner = '\\]\\-';
      }

      if (negated && inner.indexOf('.') === -1) {
        inner += '.';
      }
      if (negated && inner.indexOf('/') === -1) {
        inner += '/';
      }

      var val = open + negated + inner + close;
      var queue = node.parent.queue;
      var last = utils.arrayify(queue.pop());

      queue.push(utils.join(last, val));
      queue.push.apply(queue, []);
    })

    /**
     * Brace
     */

    .set('brace', function(node) {
      node.queue = isEscaped(node) ? [node.val] : [];
      node.count = 1;
      return this.mapVisit(node.nodes);
    })

    /**
     * Open
     */

    .set('brace.open', function(node) {
      node.parent.open = node.val;
    })

    /**
     * Inner
     */

    .set('text', function(node) {
      var queue = node.parent.queue;
      var escaped = node.escaped;
      var segs = [node.val];

      if (node.optimize === false) {
        options = utils.extend({}, options, {optimize: false});
      }

      if (node.multiplier > 1) {
        node.parent.count *= node.multiplier;
      }

      if (options.quantifiers === true && utils.isQuantifier(node.val)) {
        escaped = true;

      } else if (node.val.length > 1) {
        if (isType(node.parent, 'brace') && !isEscaped(node)) {
          var expanded = utils.expand(node.val, options);
          segs = expanded.segs;

          if (expanded.isOptimized) {
            node.parent.isOptimized = true;
          }

          // if nothing was expanded, we probably have a literal brace
          if (!segs.length) {
            var val = (expanded.val || node.val);
            if (options.unescape !== false) {
              // unescape unexpanded brace sequence/set separators
              val = val.replace(/\\([,.])/g, '$1');
              // strip quotes
              val = val.replace(/["'`]/g, '');
            }

            segs = [val];
            escaped = true;
          }
        }

      } else if (node.val === ',') {
        if (options.expand) {
          node.parent.queue.push(['']);
          segs = [''];
        } else {
          segs = ['|'];
        }
      } else {
        escaped = true;
      }

      if (escaped && isType(node.parent, 'brace')) {
        if (node.parent.nodes.length <= 4 && node.parent.count === 1) {
          node.parent.escaped = true;
        } else if (node.parent.length <= 3) {
          node.parent.escaped = true;
        }
      }

      if (!hasQueue(node.parent)) {
        node.parent.queue = segs;
        return;
      }

      var last = utils.arrayify(queue.pop());
      if (node.parent.count > 1 && options.expand) {
        last = multiply(last, node.parent.count);
        node.parent.count = 1;
      }

      queue.push(utils.join(utils.flatten(last), segs.shift()));
      queue.push.apply(queue, segs);
    })

    /**
     * Close
     */

    .set('brace.close', function(node) {
      var queue = node.parent.queue;
      var prev = node.parent.parent;
      var last = prev.queue.pop();
      var open = node.parent.open;
      var close = node.val;

      if (open && close && isOptimized(node, options)) {
        open = '(';
        close = ')';
      }

      // if a close brace exists, and the previous segment is one character
      // don't wrap the result in braces or parens
      var ele = utils.last(queue);
      if (node.parent.count > 1 && options.expand) {
        ele = multiply(queue.pop(), node.parent.count);
        node.parent.count = 1;
        queue.push(ele);
      }

      if (close && typeof ele === 'string' && ele.length === 1) {
        open = '';
        close = '';
      }

      if ((isLiteralBrace(node, options) || noInner(node)) && !node.parent.hasEmpty) {
        queue.push(utils.join(open, queue.pop() || ''));
        queue = utils.flatten(utils.join(queue, close));
      }

      if (typeof last === 'undefined') {
        prev.queue = [queue];
      } else {
        prev.queue.push(utils.flatten(utils.join(last, queue)));
      }
    })

    /**
     * eos
     */

    .set('eos', function(node) {
      if (this.input) return;

      if (options.optimize !== false) {
        this.output = utils.last(utils.flatten(this.ast.queue));
      } else if (Array.isArray(utils.last(this.ast.queue))) {
        this.output = utils.flatten(this.ast.queue.pop());
      } else {
        this.output = utils.flatten(this.ast.queue);
      }

      if (node.parent.count > 1 && options.expand) {
        this.output = multiply(this.output, node.parent.count);
      }

      this.output = utils.arrayify(this.output);
      this.ast.queue = [];
    });

};

/**
 * Multiply the segments in the current brace level
 */

function multiply(queue, n, options) {
  return utils.flatten(utils.repeat(utils.arrayify(queue), n));
}

/**
 * Return true if `node` is escaped
 */

function isEscaped(node) {
  return node.escaped === true;
}

/**
 * Returns true if regex parens should be used for sets. If the parent `type`
 * is not `brace`, then we're on a root node, which means we should never
 * expand segments and open/close braces should be `{}` (since this indicates
 * a brace is missing from the set)
 */

function isOptimized(node, options) {
  if (node.parent.isOptimized) return true;
  return isType(node.parent, 'brace')
    && !isEscaped(node.parent)
    && options.expand !== true;
}

/**
 * Returns true if the value in `node` should be wrapped in a literal brace.
 * @return {Boolean}
 */

function isLiteralBrace(node, options) {
  return isEscaped(node.parent) || options.optimize !== false;
}

/**
 * Returns true if the given `node` does not have an inner value.
 * @return {Boolean}
 */

function noInner(node, type) {
  if (node.parent.queue.length === 1) {
    return true;
  }
  var nodes = node.parent.nodes;
  return nodes.length === 3
    && isType(nodes[0], 'brace.open')
    && !isType(nodes[1], 'text')
    && isType(nodes[2], 'brace.close');
}

/**
 * Returns true if the given `node` is the given `type`
 * @return {Boolean}
 */

function isType(node, type) {
  return typeof node !== 'undefined' && node.type === type;
}

/**
 * Returns true if the given `node` has a non-empty queue.
 * @return {Boolean}
 */

function hasQueue(node) {
  return Array.isArray(node.queue) && node.queue.length;
}


/***/ }),

/***/ 2829:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var Node = __nccwpck_require__(5244);
var utils = __nccwpck_require__(5207);

/**
 * Braces parsers
 */

module.exports = function(braces, options) {
  braces.parser
    .set('bos', function() {
      if (!this.parsed) {
        this.ast = this.nodes[0] = new Node(this.ast);
      }
    })

    /**
     * Character parsers
     */

    .set('escape', function() {
      var pos = this.position();
      var m = this.match(/^(?:\\(.)|\$\{)/);
      if (!m) return;

      var prev = this.prev();
      var last = utils.last(prev.nodes);

      var node = pos(new Node({
        type: 'text',
        multiplier: 1,
        val: m[0]
      }));

      if (node.val === '\\\\') {
        return node;
      }

      if (node.val === '${') {
        var str = this.input;
        var idx = -1;
        var ch;

        while ((ch = str[++idx])) {
          this.consume(1);
          node.val += ch;
          if (ch === '\\') {
            node.val += str[++idx];
            continue;
          }
          if (ch === '}') {
            break;
          }
        }
      }

      if (this.options.unescape !== false) {
        node.val = node.val.replace(/\\([{}])/g, '$1');
      }

      if (last.val === '"' && this.input.charAt(0) === '"') {
        last.val = node.val;
        this.consume(1);
        return;
      }

      return concatNodes.call(this, pos, node, prev, options);
    })

    /**
     * Brackets: "[...]" (basic, this is overridden by
     * other parsers in more advanced implementations)
     */

    .set('bracket', function() {
      var isInside = this.isInside('brace');
      var pos = this.position();
      var m = this.match(/^(?:\[([!^]?)([^\]]{2,}|\]-)(\]|[^*+?]+)|\[)/);
      if (!m) return;

      var prev = this.prev();
      var val = m[0];
      var negated = m[1] ? '^' : '';
      var inner = m[2] || '';
      var close = m[3] || '';

      if (isInside && prev.type === 'brace') {
        prev.text = prev.text || '';
        prev.text += val;
      }

      var esc = this.input.slice(0, 2);
      if (inner === '' && esc === '\\]') {
        inner += esc;
        this.consume(2);

        var str = this.input;
        var idx = -1;
        var ch;

        while ((ch = str[++idx])) {
          this.consume(1);
          if (ch === ']') {
            close = ch;
            break;
          }
          inner += ch;
        }
      }

      return pos(new Node({
        type: 'bracket',
        val: val,
        escaped: close !== ']',
        negated: negated,
        inner: inner,
        close: close
      }));
    })

    /**
     * Empty braces (we capture these early to
     * speed up processing in the compiler)
     */

    .set('multiplier', function() {
      var isInside = this.isInside('brace');
      var pos = this.position();
      var m = this.match(/^\{((?:,|\{,+\})+)\}/);
      if (!m) return;

      this.multiplier = true;
      var prev = this.prev();
      var val = m[0];

      if (isInside && prev.type === 'brace') {
        prev.text = prev.text || '';
        prev.text += val;
      }

      var node = pos(new Node({
        type: 'text',
        multiplier: 1,
        match: m,
        val: val
      }));

      return concatNodes.call(this, pos, node, prev, options);
    })

    /**
     * Open
     */

    .set('brace.open', function() {
      var pos = this.position();
      var m = this.match(/^\{(?!(?:[^\\}]?|,+)\})/);
      if (!m) return;

      var prev = this.prev();
      var last = utils.last(prev.nodes);

      // if the last parsed character was an extglob character
      // we need to _not optimize_ the brace pattern because
      // it might be mistaken for an extglob by a downstream parser
      if (last && last.val && isExtglobChar(last.val.slice(-1))) {
        last.optimize = false;
      }

      var open = pos(new Node({
        type: 'brace.open',
        val: m[0]
      }));

      var node = pos(new Node({
        type: 'brace',
        nodes: []
      }));

      node.push(open);
      prev.push(node);
      this.push('brace', node);
    })

    /**
     * Close
     */

    .set('brace.close', function() {
      var pos = this.position();
      var m = this.match(/^\}/);
      if (!m || !m[0]) return;

      var brace = this.pop('brace');
      var node = pos(new Node({
        type: 'brace.close',
        val: m[0]
      }));

      if (!this.isType(brace, 'brace')) {
        if (this.options.strict) {
          throw new Error('missing opening "{"');
        }
        node.type = 'text';
        node.multiplier = 0;
        node.escaped = true;
        return node;
      }

      var prev = this.prev();
      var last = utils.last(prev.nodes);
      if (last.text) {
        var lastNode = utils.last(last.nodes);
        if (lastNode.val === ')' && /[!@*?+]\(/.test(last.text)) {
          var open = last.nodes[0];
          var text = last.nodes[1];
          if (open.type === 'brace.open' && text && text.type === 'text') {
            text.optimize = false;
          }
        }
      }

      if (brace.nodes.length > 2) {
        var first = brace.nodes[1];
        if (first.type === 'text' && first.val === ',') {
          brace.nodes.splice(1, 1);
          brace.nodes.push(first);
        }
      }

      brace.push(node);
    })

    /**
     * Capture boundary characters
     */

    .set('boundary', function() {
      var pos = this.position();
      var m = this.match(/^[$^](?!\{)/);
      if (!m) return;
      return pos(new Node({
        type: 'text',
        val: m[0]
      }));
    })

    /**
     * One or zero, non-comma characters wrapped in braces
     */

    .set('nobrace', function() {
      var isInside = this.isInside('brace');
      var pos = this.position();
      var m = this.match(/^\{[^,]?\}/);
      if (!m) return;

      var prev = this.prev();
      var val = m[0];

      if (isInside && prev.type === 'brace') {
        prev.text = prev.text || '';
        prev.text += val;
      }

      return pos(new Node({
        type: 'text',
        multiplier: 0,
        val: val
      }));
    })

    /**
     * Text
     */

    .set('text', function() {
      var isInside = this.isInside('brace');
      var pos = this.position();
      var m = this.match(/^((?!\\)[^${}[\]])+/);
      if (!m) return;

      var prev = this.prev();
      var val = m[0];

      if (isInside && prev.type === 'brace') {
        prev.text = prev.text || '';
        prev.text += val;
      }

      var node = pos(new Node({
        type: 'text',
        multiplier: 1,
        val: val
      }));

      return concatNodes.call(this, pos, node, prev, options);
    });
};

/**
 * Returns true if the character is an extglob character.
 */

function isExtglobChar(ch) {
  return ch === '!' || ch === '@' || ch === '*' || ch === '?' || ch === '+';
}

/**
 * Combine text nodes, and calculate empty sets (`{,,}`)
 * @param {Function} `pos` Function to calculate node position
 * @param {Object} `node` AST node
 * @return {Object}
 */

function concatNodes(pos, node, parent, options) {
  node.orig = node.val;
  var prev = this.prev();
  var last = utils.last(prev.nodes);
  var isEscaped = false;

  if (node.val.length > 1) {
    var a = node.val.charAt(0);
    var b = node.val.slice(-1);

    isEscaped = (a === '"' && b === '"')
      || (a === "'" && b === "'")
      || (a === '`' && b === '`');
  }

  if (isEscaped && options.unescape !== false) {
    node.val = node.val.slice(1, node.val.length - 1);
    node.escaped = true;
  }

  if (node.match) {
    var match = node.match[1];
    if (!match || match.indexOf('}') === -1) {
      match = node.match[0];
    }

    // replace each set with a single ","
    var val = match.replace(/\{/g, ',').replace(/\}/g, '');
    node.multiplier *= val.length;
    node.val = '';
  }

  var simpleText = last.type === 'text'
    && last.multiplier === 1
    && node.multiplier === 1
    && node.val;

  if (simpleText) {
    last.val += node.val;
    return;
  }

  prev.push(node);
}


/***/ }),

/***/ 5207:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var splitString = __nccwpck_require__(4960);
var utils = module.exports;

/**
 * Module dependencies
 */

utils.extend = __nccwpck_require__(7512);
utils.flatten = __nccwpck_require__(7493);
utils.isObject = __nccwpck_require__(5509);
utils.fillRange = __nccwpck_require__(6330);
utils.repeat = __nccwpck_require__(3301);
utils.unique = __nccwpck_require__(340);

utils.define = function(obj, key, val) {
  Object.defineProperty(obj, key, {
    writable: true,
    configurable: true,
    enumerable: false,
    value: val
  });
};

/**
 * Returns true if the given string contains only empty brace sets.
 */

utils.isEmptySets = function(str) {
  return /^(?:\{,\})+$/.test(str);
};

/**
 * Returns true if the given string contains only empty brace sets.
 */

utils.isQuotedString = function(str) {
  var open = str.charAt(0);
  if (open === '\'' || open === '"' || open === '`') {
    return str.slice(-1) === open;
  }
  return false;
};

/**
 * Create the key to use for memoization. The unique key is generated
 * by iterating over the options and concatenating key-value pairs
 * to the pattern string.
 */

utils.createKey = function(pattern, options) {
  var id = pattern;
  if (typeof options === 'undefined') {
    return id;
  }
  var keys = Object.keys(options);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    id += ';' + key + '=' + String(options[key]);
  }
  return id;
};

/**
 * Normalize options
 */

utils.createOptions = function(options) {
  var opts = utils.extend.apply(null, arguments);
  if (typeof opts.expand === 'boolean') {
    opts.optimize = !opts.expand;
  }
  if (typeof opts.optimize === 'boolean') {
    opts.expand = !opts.optimize;
  }
  if (opts.optimize === true) {
    opts.makeRe = true;
  }
  return opts;
};

/**
 * Join patterns in `a` to patterns in `b`
 */

utils.join = function(a, b, options) {
  options = options || {};
  a = utils.arrayify(a);
  b = utils.arrayify(b);

  if (!a.length) return b;
  if (!b.length) return a;

  var len = a.length;
  var idx = -1;
  var arr = [];

  while (++idx < len) {
    var val = a[idx];
    if (Array.isArray(val)) {
      for (var i = 0; i < val.length; i++) {
        val[i] = utils.join(val[i], b, options);
      }
      arr.push(val);
      continue;
    }

    for (var j = 0; j < b.length; j++) {
      var bval = b[j];

      if (Array.isArray(bval)) {
        arr.push(utils.join(val, bval, options));
      } else {
        arr.push(val + bval);
      }
    }
  }
  return arr;
};

/**
 * Split the given string on `,` if not escaped.
 */

utils.split = function(str, options) {
  var opts = utils.extend({sep: ','}, options);
  if (typeof opts.keepQuotes !== 'boolean') {
    opts.keepQuotes = true;
  }
  if (opts.unescape === false) {
    opts.keepEscaping = true;
  }
  return splitString(str, opts, utils.escapeBrackets(opts));
};

/**
 * Expand ranges or sets in the given `pattern`.
 *
 * @param {String} `str`
 * @param {Object} `options`
 * @return {Object}
 */

utils.expand = function(str, options) {
  var opts = utils.extend({rangeLimit: 10000}, options);
  var segs = utils.split(str, opts);
  var tok = { segs: segs };

  if (utils.isQuotedString(str)) {
    return tok;
  }

  if (opts.rangeLimit === true) {
    opts.rangeLimit = 10000;
  }

  if (segs.length > 1) {
    if (opts.optimize === false) {
      tok.val = segs[0];
      return tok;
    }

    tok.segs = utils.stringifyArray(tok.segs);
  } else if (segs.length === 1) {
    var arr = str.split('..');

    if (arr.length === 1) {
      tok.val = tok.segs[tok.segs.length - 1] || tok.val || str;
      tok.segs = [];
      return tok;
    }

    if (arr.length === 2 && arr[0] === arr[1]) {
      tok.escaped = true;
      tok.val = arr[0];
      tok.segs = [];
      return tok;
    }

    if (arr.length > 1) {
      if (opts.optimize !== false) {
        opts.optimize = true;
        delete opts.expand;
      }

      if (opts.optimize !== true) {
        var min = Math.min(arr[0], arr[1]);
        var max = Math.max(arr[0], arr[1]);
        var step = arr[2] || 1;

        if (opts.rangeLimit !== false && ((max - min) / step >= opts.rangeLimit)) {
          throw new RangeError('expanded array length exceeds range limit. Use options.rangeLimit to increase or disable the limit.');
        }
      }

      arr.push(opts);
      tok.segs = utils.fillRange.apply(null, arr);

      if (!tok.segs.length) {
        tok.escaped = true;
        tok.val = str;
        return tok;
      }

      if (opts.optimize === true) {
        tok.segs = utils.stringifyArray(tok.segs);
      }

      if (tok.segs === '') {
        tok.val = str;
      } else {
        tok.val = tok.segs[0];
      }
      return tok;
    }
  } else {
    tok.val = str;
  }
  return tok;
};

/**
 * Ensure commas inside brackets and parens are not split.
 * @param {Object} `tok` Token from the `split-string` module
 * @return {undefined}
 */

utils.escapeBrackets = function(options) {
  return function(tok) {
    if (tok.escaped && tok.val === 'b') {
      tok.val = '\\b';
      return;
    }

    if (tok.val !== '(' && tok.val !== '[') return;
    var opts = utils.extend({}, options);
    var brackets = [];
    var parens = [];
    var stack = [];
    var val = tok.val;
    var str = tok.str;
    var i = tok.idx - 1;

    while (++i < str.length) {
      var ch = str[i];

      if (ch === '\\') {
        val += (opts.keepEscaping === false ? '' : ch) + str[++i];
        continue;
      }

      if (ch === '(') {
        parens.push(ch);
        stack.push(ch);
      }

      if (ch === '[') {
        brackets.push(ch);
        stack.push(ch);
      }

      if (ch === ')') {
        parens.pop();
        stack.pop();
        if (!stack.length) {
          val += ch;
          break;
        }
      }

      if (ch === ']') {
        brackets.pop();
        stack.pop();
        if (!stack.length) {
          val += ch;
          break;
        }
      }
      val += ch;
    }

    tok.split = false;
    tok.val = val.slice(1);
    tok.idx = i;
  };
};

/**
 * Returns true if the given string looks like a regex quantifier
 * @return {Boolean}
 */

utils.isQuantifier = function(str) {
  return /^(?:[0-9]?,[0-9]|[0-9],)$/.test(str);
};

/**
 * Cast `val` to an array.
 * @param {*} `val`
 */

utils.stringifyArray = function(arr) {
  return [utils.arrayify(arr).join('|')];
};

/**
 * Cast `val` to an array.
 * @param {*} `val`
 */

utils.arrayify = function(arr) {
  if (typeof arr === 'undefined') {
    return [];
  }
  if (typeof arr === 'string') {
    return [arr];
  }
  return arr;
};

/**
 * Returns true if the given `str` is a non-empty string
 * @return {Boolean}
 */

utils.isString = function(str) {
  return str != null && typeof str === 'string';
};

/**
 * Get the last element from `array`
 * @param {Array} `array`
 * @return {*}
 */

utils.last = function(arr, n) {
  return arr[arr.length - (n || 1)];
};

utils.escapeRegex = function(str) {
  return str.replace(/\\?([!^*?()[\]{}+?/])/g, '\\$1');
};


/***/ }),

/***/ 4365:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var isObject = __nccwpck_require__(5509);
var Emitter = __nccwpck_require__(6172);
var visit = __nccwpck_require__(3434);
var toPath = __nccwpck_require__(8636);
var union = __nccwpck_require__(7303);
var del = __nccwpck_require__(1571);
var get = __nccwpck_require__(9611);
var has = __nccwpck_require__(8887);
var set = __nccwpck_require__(4269);

/**
 * Create a `Cache` constructor that when instantiated will
 * store values on the given `prop`.
 *
 * ```js
 * var Cache = require('cache-base').namespace('data');
 * var cache = new Cache();
 *
 * cache.set('foo', 'bar');
 * //=> {data: {foo: 'bar'}}
 * ```
 * @param {String} `prop` The property name to use for storing values.
 * @return {Function} Returns a custom `Cache` constructor
 * @api public
 */

function namespace(prop) {

  /**
   * Create a new `Cache`. Internally the `Cache` constructor is created using
   * the `namespace` function, with `cache` defined as the storage object.
   *
   * ```js
   * var app = new Cache();
   * ```
   * @param {Object} `cache` Optionally pass an object to initialize with.
   * @constructor
   * @api public
   */

  function Cache(cache) {
    if (prop) {
      this[prop] = {};
    }
    if (cache) {
      this.set(cache);
    }
  }

  /**
   * Inherit Emitter
   */

  Emitter(Cache.prototype);

  /**
   * Assign `value` to `key`. Also emits `set` with
   * the key and value.
   *
   * ```js
   * app.on('set', function(key, val) {
   *   // do something when `set` is emitted
   * });
   *
   * app.set(key, value);
   *
   * // also takes an object or array
   * app.set({name: 'Halle'});
   * app.set([{foo: 'bar'}, {baz: 'quux'}]);
   * console.log(app);
   * //=> {name: 'Halle', foo: 'bar', baz: 'quux'}
   * ```
   *
   * @name .set
   * @emits `set` with `key` and `value` as arguments.
   * @param {String} `key`
   * @param {any} `value`
   * @return {Object} Returns the instance for chaining.
   * @api public
   */

  Cache.prototype.set = function(key, val) {
    if (Array.isArray(key) && arguments.length === 2) {
      key = toPath(key);
    }
    if (isObject(key) || Array.isArray(key)) {
      this.visit('set', key);
    } else {
      set(prop ? this[prop] : this, key, val);
      this.emit('set', key, val);
    }
    return this;
  };

  /**
   * Union `array` to `key`. Also emits `set` with
   * the key and value.
   *
   * ```js
   * app.union('a.b', ['foo']);
   * app.union('a.b', ['bar']);
   * console.log(app.get('a'));
   * //=> {b: ['foo', 'bar']}
   * ```
   * @name .union
   * @param {String} `key`
   * @param {any} `value`
   * @return {Object} Returns the instance for chaining.
   * @api public
   */

  Cache.prototype.union = function(key, val) {
    if (Array.isArray(key) && arguments.length === 2) {
      key = toPath(key);
    }
    var ctx = prop ? this[prop] : this;
    union(ctx, key, arrayify(val));
    this.emit('union', val);
    return this;
  };

  /**
   * Return the value of `key`. Dot notation may be used
   * to get [nested property values][get-value].
   *
   * ```js
   * app.set('a.b.c', 'd');
   * app.get('a.b');
   * //=> {c: 'd'}
   *
   * app.get(['a', 'b']);
   * //=> {c: 'd'}
   * ```
   *
   * @name .get
   * @emits `get` with `key` and `value` as arguments.
   * @param {String} `key` The name of the property to get. Dot-notation may be used.
   * @return {any} Returns the value of `key`
   * @api public
   */

  Cache.prototype.get = function(key) {
    key = toPath(arguments);

    var ctx = prop ? this[prop] : this;
    var val = get(ctx, key);

    this.emit('get', key, val);
    return val;
  };

  /**
   * Return true if app has a stored value for `key`,
   * false only if value is `undefined`.
   *
   * ```js
   * app.set('foo', 'bar');
   * app.has('foo');
   * //=> true
   * ```
   *
   * @name .has
   * @emits `has` with `key` and true or false as arguments.
   * @param {String} `key`
   * @return {Boolean}
   * @api public
   */

  Cache.prototype.has = function(key) {
    key = toPath(arguments);

    var ctx = prop ? this[prop] : this;
    var val = get(ctx, key);

    var has = typeof val !== 'undefined';
    this.emit('has', key, has);
    return has;
  };

  /**
   * Delete one or more properties from the instance.
   *
   * ```js
   * app.del(); // delete all
   * // or
   * app.del('foo');
   * // or
   * app.del(['foo', 'bar']);
   * ```
   * @name .del
   * @emits `del` with the `key` as the only argument.
   * @param {String|Array} `key` Property name or array of property names.
   * @return {Object} Returns the instance for chaining.
   * @api public
   */

  Cache.prototype.del = function(key) {
    if (Array.isArray(key)) {
      this.visit('del', key);
    } else {
      del(prop ? this[prop] : this, key);
      this.emit('del', key);
    }
    return this;
  };

  /**
   * Reset the entire cache to an empty object.
   *
   * ```js
   * app.clear();
   * ```
   * @api public
   */

  Cache.prototype.clear = function() {
    if (prop) {
      this[prop] = {};
    }
  };

  /**
   * Visit `method` over the properties in the given object, or map
   * visit over the object-elements in an array.
   *
   * @name .visit
   * @param {String} `method` The name of the `base` method to call.
   * @param {Object|Array} `val` The object or array to iterate over.
   * @return {Object} Returns the instance for chaining.
   * @api public
   */

  Cache.prototype.visit = function(method, val) {
    visit(this, method, val);
    return this;
  };

  return Cache;
}

/**
 * Cast val to an array
 */

function arrayify(val) {
  return val ? (Array.isArray(val) ? val : [val]) : [];
}

/**
 * Expose `Cache`
 */

module.exports = namespace();

/**
 * Expose `Cache.namespace`
 */

module.exports.namespace = namespace;


/***/ }),

/***/ 9581:
/***/ ((module) => {



var next = (global.process && process.nextTick) || global.setImmediate || function (f) {
  setTimeout(f, 0)
}

module.exports = function maybe (cb, promise) {
  if (cb) {
    promise
      .then(function (result) {
        next(function () { cb(null, result) })
      }, function (err) {
        next(function () { cb(err) })
      })
    return undefined
  }
  else {
    return promise
  }
}


/***/ }),

/***/ 274:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var util = __nccwpck_require__(3837);
var union = __nccwpck_require__(8815);
var define = __nccwpck_require__(6967);
var staticExtend = __nccwpck_require__(9480);
var isObj = __nccwpck_require__(5509);

/**
 * Expose class utils
 */

var cu = module.exports;

/**
 * Expose class utils: `cu`
 */

cu.isObject = function isObject(val) {
  return isObj(val) || typeof val === 'function';
};

/**
 * Returns true if an array has any of the given elements, or an
 * object has any of the give keys.
 *
 * ```js
 * cu.has(['a', 'b', 'c'], 'c');
 * //=> true
 *
 * cu.has(['a', 'b', 'c'], ['c', 'z']);
 * //=> true
 *
 * cu.has({a: 'b', c: 'd'}, ['c', 'z']);
 * //=> true
 * ```
 * @param {Object} `obj`
 * @param {String|Array} `val`
 * @return {Boolean}
 * @api public
 */

cu.has = function has(obj, val) {
  val = cu.arrayify(val);
  var len = val.length;

  if (cu.isObject(obj)) {
    for (var key in obj) {
      if (val.indexOf(key) > -1) {
        return true;
      }
    }

    var keys = cu.nativeKeys(obj);
    return cu.has(keys, val);
  }

  if (Array.isArray(obj)) {
    var arr = obj;
    while (len--) {
      if (arr.indexOf(val[len]) > -1) {
        return true;
      }
    }
    return false;
  }

  throw new TypeError('expected an array or object.');
};

/**
 * Returns true if an array or object has all of the given values.
 *
 * ```js
 * cu.hasAll(['a', 'b', 'c'], 'c');
 * //=> true
 *
 * cu.hasAll(['a', 'b', 'c'], ['c', 'z']);
 * //=> false
 *
 * cu.hasAll({a: 'b', c: 'd'}, ['c', 'z']);
 * //=> false
 * ```
 * @param {Object|Array} `val`
 * @param {String|Array} `values`
 * @return {Boolean}
 * @api public
 */

cu.hasAll = function hasAll(val, values) {
  values = cu.arrayify(values);
  var len = values.length;
  while (len--) {
    if (!cu.has(val, values[len])) {
      return false;
    }
  }
  return true;
};

/**
 * Cast the given value to an array.
 *
 * ```js
 * cu.arrayify('foo');
 * //=> ['foo']
 *
 * cu.arrayify(['foo']);
 * //=> ['foo']
 * ```
 *
 * @param {String|Array} `val`
 * @return {Array}
 * @api public
 */

cu.arrayify = function arrayify(val) {
  return val ? (Array.isArray(val) ? val : [val]) : [];
};

/**
 * Noop
 */

cu.noop = function noop() {
  return;
};

/**
 * Returns the first argument passed to the function.
 */

cu.identity = function identity(val) {
  return val;
};

/**
 * Returns true if a value has a `contructor`
 *
 * ```js
 * cu.hasConstructor({});
 * //=> true
 *
 * cu.hasConstructor(Object.create(null));
 * //=> false
 * ```
 * @param  {Object} `value`
 * @return {Boolean}
 * @api public
 */

cu.hasConstructor = function hasConstructor(val) {
  return cu.isObject(val) && typeof val.constructor !== 'undefined';
};

/**
 * Get the native `ownPropertyNames` from the constructor of the
 * given `object`. An empty array is returned if the object does
 * not have a constructor.
 *
 * ```js
 * cu.nativeKeys({a: 'b', b: 'c', c: 'd'})
 * //=> ['a', 'b', 'c']
 *
 * cu.nativeKeys(function(){})
 * //=> ['length', 'caller']
 * ```
 *
 * @param  {Object} `obj` Object that has a `constructor`.
 * @return {Array} Array of keys.
 * @api public
 */

cu.nativeKeys = function nativeKeys(val) {
  if (!cu.hasConstructor(val)) return [];
  var keys = Object.getOwnPropertyNames(val);
  if ('caller' in val) keys.push('caller');
  return keys;
};

/**
 * Returns property descriptor `key` if it's an "own" property
 * of the given object.
 *
 * ```js
 * function App() {}
 * Object.defineProperty(App.prototype, 'count', {
 *   get: function() {
 *     return Object.keys(this).length;
 *   }
 * });
 * cu.getDescriptor(App.prototype, 'count');
 * // returns:
 * // {
 * //   get: [Function],
 * //   set: undefined,
 * //   enumerable: false,
 * //   configurable: false
 * // }
 * ```
 *
 * @param {Object} `obj`
 * @param {String} `key`
 * @return {Object} Returns descriptor `key`
 * @api public
 */

cu.getDescriptor = function getDescriptor(obj, key) {
  if (!cu.isObject(obj)) {
    throw new TypeError('expected an object.');
  }
  if (typeof key !== 'string') {
    throw new TypeError('expected key to be a string.');
  }
  return Object.getOwnPropertyDescriptor(obj, key);
};

/**
 * Copy a descriptor from one object to another.
 *
 * ```js
 * function App() {}
 * Object.defineProperty(App.prototype, 'count', {
 *   get: function() {
 *     return Object.keys(this).length;
 *   }
 * });
 * var obj = {};
 * cu.copyDescriptor(obj, App.prototype, 'count');
 * ```
 * @param {Object} `receiver`
 * @param {Object} `provider`
 * @param {String} `name`
 * @return {Object}
 * @api public
 */

cu.copyDescriptor = function copyDescriptor(receiver, provider, name) {
  if (!cu.isObject(receiver)) {
    throw new TypeError('expected receiving object to be an object.');
  }
  if (!cu.isObject(provider)) {
    throw new TypeError('expected providing object to be an object.');
  }
  if (typeof name !== 'string') {
    throw new TypeError('expected name to be a string.');
  }

  var val = cu.getDescriptor(provider, name);
  if (val) Object.defineProperty(receiver, name, val);
};

/**
 * Copy static properties, prototype properties, and descriptors
 * from one object to another.
 *
 * @param {Object} `receiver`
 * @param {Object} `provider`
 * @param {String|Array} `omit` One or more properties to omit
 * @return {Object}
 * @api public
 */

cu.copy = function copy(receiver, provider, omit) {
  if (!cu.isObject(receiver)) {
    throw new TypeError('expected receiving object to be an object.');
  }
  if (!cu.isObject(provider)) {
    throw new TypeError('expected providing object to be an object.');
  }
  var props = Object.getOwnPropertyNames(provider);
  var keys = Object.keys(provider);
  var len = props.length,
    key;
  omit = cu.arrayify(omit);

  while (len--) {
    key = props[len];

    if (cu.has(keys, key)) {
      define(receiver, key, provider[key]);
    } else if (!(key in receiver) && !cu.has(omit, key)) {
      cu.copyDescriptor(receiver, provider, key);
    }
  }
};

/**
 * Inherit the static properties, prototype properties, and descriptors
 * from of an object.
 *
 * @param {Object} `receiver`
 * @param {Object} `provider`
 * @param {String|Array} `omit` One or more properties to omit
 * @return {Object}
 * @api public
 */

cu.inherit = function inherit(receiver, provider, omit) {
  if (!cu.isObject(receiver)) {
    throw new TypeError('expected receiving object to be an object.');
  }
  if (!cu.isObject(provider)) {
    throw new TypeError('expected providing object to be an object.');
  }

  var keys = [];
  for (var key in provider) {
    keys.push(key);
    receiver[key] = provider[key];
  }

  keys = keys.concat(cu.arrayify(omit));

  var a = provider.prototype || provider;
  var b = receiver.prototype || receiver;
  cu.copy(b, a, keys);
};

/**
 * Returns a function for extending the static properties,
 * prototype properties, and descriptors from the `Parent`
 * constructor onto `Child` constructors.
 *
 * ```js
 * var extend = cu.extend(Parent);
 * Parent.extend(Child);
 *
 * // optional methods
 * Parent.extend(Child, {
 *   foo: function() {},
 *   bar: function() {}
 * });
 * ```
 * @param {Function} `Parent` Parent ctor
 * @param {Function} `extend` Optional extend function to handle custom extensions. Useful when updating methods that require a specific prototype.
 *   @param {Function} `Child` Child ctor
 *   @param {Object} `proto` Optionally pass additional prototype properties to inherit.
 *   @return {Object}
 * @api public
 */

cu.extend = function() {
  // keep it lazy, instead of assigning to `cu.extend`
  return staticExtend.apply(null, arguments);
};

/**
 * Bubble up events emitted from static methods on the Parent ctor.
 *
 * @param {Object} `Parent`
 * @param {Array} `events` Event names to bubble up
 * @api public
 */

cu.bubble = function(Parent, events) {
  events = events || [];
  Parent.bubble = function(Child, arr) {
    if (Array.isArray(arr)) {
      events = union([], events, arr);
    }
    var len = events.length;
    var idx = -1;
    while (++idx < len) {
      var name = events[idx];
      Parent.on(name, Child.emit.bind(Child, name));
    }
    cu.bubble(Child, events);
  };
};


/***/ }),

/***/ 7972:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {


const os = __nccwpck_require__(2037);

const extractPathRegex = /\s+at.*(?:\(|\s)(.*)\)?/;
const pathRegex = /^(?:(?:(?:node|(?:internal\/[\w/]*|.*node_modules\/(?:babel-polyfill|pirates)\/.*)?\w+)\.js:\d+:\d+)|native)/;
const homeDir = typeof os.homedir === 'undefined' ? '' : os.homedir();

module.exports = (stack, options) => {
	options = Object.assign({pretty: false}, options);

	return stack.replace(/\\/g, '/')
		.split('\n')
		.filter(line => {
			const pathMatches = line.match(extractPathRegex);
			if (pathMatches === null || !pathMatches[1]) {
				return true;
			}

			const match = pathMatches[1];

			// Electron
			if (
				match.includes('.app/Contents/Resources/electron.asar') ||
				match.includes('.app/Contents/Resources/default_app.asar')
			) {
				return false;
			}

			return !pathRegex.test(match);
		})
		.filter(line => line.trim() !== '')
		.map(line => {
			if (options.pretty) {
				return line.replace(extractPathRegex, (m, p1) => m.replace(p1, p1.replace(homeDir, '~')));
			}

			return line;
		})
		.join('\n');
};


/***/ }),

/***/ 3434:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * collection-visit <https://github.com/jonschlinkert/collection-visit>
 *
 * Copyright (c) 2015, 2017, Jon Schlinkert.
 * Released under the MIT License.
 */



var visit = __nccwpck_require__(3178);
var mapVisit = __nccwpck_require__(2144);

module.exports = function(collection, method, val) {
  var result;

  if (typeof val === 'string' && (method in collection)) {
    var args = [].slice.call(arguments, 2);
    result = collection[method].apply(collection, args);
  } else if (Array.isArray(val)) {
    result = mapVisit.apply(null, arguments);
  } else {
    result = visit.apply(null, arguments);
  }

  if (typeof result !== 'undefined') {
    return result;
  }

  return collection;
};


/***/ }),

/***/ 6172:
/***/ ((module) => {


/**
 * Expose `Emitter`.
 */

if (true) {
  module.exports = Emitter;
}

/**
 * Initialize a new `Emitter`.
 *
 * @api public
 */

function Emitter(obj) {
  if (obj) return mixin(obj);
};

/**
 * Mixin the emitter properties.
 *
 * @param {Object} obj
 * @return {Object}
 * @api private
 */

function mixin(obj) {
  for (var key in Emitter.prototype) {
    obj[key] = Emitter.prototype[key];
  }
  return obj;
}

/**
 * Listen on the given `event` with `fn`.
 *
 * @param {String} event
 * @param {Function} fn
 * @return {Emitter}
 * @api public
 */

Emitter.prototype.on =
Emitter.prototype.addEventListener = function(event, fn){
  this._callbacks = this._callbacks || {};
  (this._callbacks['$' + event] = this._callbacks['$' + event] || [])
    .push(fn);
  return this;
};

/**
 * Adds an `event` listener that will be invoked a single
 * time then automatically removed.
 *
 * @param {String} event
 * @param {Function} fn
 * @return {Emitter}
 * @api public
 */

Emitter.prototype.once = function(event, fn){
  function on() {
    this.off(event, on);
    fn.apply(this, arguments);
  }

  on.fn = fn;
  this.on(event, on);
  return this;
};

/**
 * Remove the given callback for `event` or all
 * registered callbacks.
 *
 * @param {String} event
 * @param {Function} fn
 * @return {Emitter}
 * @api public
 */

Emitter.prototype.off =
Emitter.prototype.removeListener =
Emitter.prototype.removeAllListeners =
Emitter.prototype.removeEventListener = function(event, fn){
  this._callbacks = this._callbacks || {};

  // all
  if (0 == arguments.length) {
    this._callbacks = {};
    return this;
  }

  // specific event
  var callbacks = this._callbacks['$' + event];
  if (!callbacks) return this;

  // remove all handlers
  if (1 == arguments.length) {
    delete this._callbacks['$' + event];
    return this;
  }

  // remove specific handler
  var cb;
  for (var i = 0; i < callbacks.length; i++) {
    cb = callbacks[i];
    if (cb === fn || cb.fn === fn) {
      callbacks.splice(i, 1);
      break;
    }
  }

  // Remove event specific arrays for event types that no
  // one is subscribed for to avoid memory leak.
  if (callbacks.length === 0) {
    delete this._callbacks['$' + event];
  }

  return this;
};

/**
 * Emit `event` with the given args.
 *
 * @param {String} event
 * @param {Mixed} ...
 * @return {Emitter}
 */

Emitter.prototype.emit = function(event){
  this._callbacks = this._callbacks || {};

  var args = new Array(arguments.length - 1)
    , callbacks = this._callbacks['$' + event];

  for (var i = 1; i < arguments.length; i++) {
    args[i - 1] = arguments[i];
  }

  if (callbacks) {
    callbacks = callbacks.slice(0);
    for (var i = 0, len = callbacks.length; i < len; ++i) {
      callbacks[i].apply(this, args);
    }
  }

  return this;
};

/**
 * Return array of callbacks for `event`.
 *
 * @param {String} event
 * @return {Array}
 * @api public
 */

Emitter.prototype.listeners = function(event){
  this._callbacks = this._callbacks || {};
  return this._callbacks['$' + event] || [];
};

/**
 * Check if this emitter has `event` handlers.
 *
 * @param {String} event
 * @return {Boolean}
 * @api public
 */

Emitter.prototype.hasListeners = function(event){
  return !! this.listeners(event).length;
};


/***/ }),

/***/ 6891:
/***/ ((module) => {

module.exports = function (xs, fn) {
    var res = [];
    for (var i = 0; i < xs.length; i++) {
        var x = fn(xs[i], i);
        if (isArray(x)) res.push.apply(res, x);
        else res.push(x);
    }
    return res;
};

var isArray = Array.isArray || function (xs) {
    return Object.prototype.toString.call(xs) === '[object Array]';
};


/***/ }),

/***/ 1102:
/***/ ((module) => {

/*!
 * copy-descriptor <https://github.com/jonschlinkert/copy-descriptor>
 *
 * Copyright (c) 2015, Jon Schlinkert.
 * Licensed under the MIT License.
 */



/**
 * Copy a descriptor from one object to another.
 *
 * ```js
 * function App() {
 *   this.cache = {};
 * }
 * App.prototype.set = function(key, val) {
 *   this.cache[key] = val;
 *   return this;
 * };
 * Object.defineProperty(App.prototype, 'count', {
 *   get: function() {
 *     return Object.keys(this.cache).length;
 *   }
 * });
 *
 * copy(App.prototype, 'count', 'len');
 *
 * // create an instance
 * var app = new App();
 *
 * app.set('a', true);
 * app.set('b', true);
 * app.set('c', true);
 *
 * console.log(app.count);
 * //=> 3
 * console.log(app.len);
 * //=> 3
 * ```
 * @name copy
 * @param {Object} `receiver` The target object
 * @param {Object} `provider` The provider object
 * @param {String} `from` The key to copy on provider.
 * @param {String} `to` Optionally specify a new key name to use.
 * @return {Object}
 * @api public
 */

module.exports = function copyDescriptor(receiver, provider, from, to) {
  if (!isObject(provider) && typeof provider !== 'function') {
    to = from;
    from = provider;
    provider = receiver;
  }
  if (!isObject(receiver) && typeof receiver !== 'function') {
    throw new TypeError('expected the first argument to be an object');
  }
  if (!isObject(provider) && typeof provider !== 'function') {
    throw new TypeError('expected provider to be an object');
  }

  if (typeof to !== 'string') {
    to = from;
  }
  if (typeof from !== 'string') {
    throw new TypeError('expected key to be a string');
  }

  if (!(from in provider)) {
    throw new Error('property "' + from + '" does not exist');
  }

  var val = Object.getOwnPropertyDescriptor(provider, from);
  if (val) Object.defineProperty(receiver, to, val);
};

function isObject(val) {
  return {}.toString.call(val) === '[object Object]';
}



/***/ }),

/***/ 8634:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {


const NestedError = __nccwpck_require__(7978);

class CpFileError extends NestedError {
	constructor(message, nested) {
		super(message, nested);
		Object.assign(this, nested);
		this.name = 'CpFileError';
	}
}

module.exports = CpFileError;


/***/ }),

/***/ 6312:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {


const {promisify} = __nccwpck_require__(3837);
const fs = __nccwpck_require__(7758);
const makeDir = __nccwpck_require__(9126);
const pEvent = __nccwpck_require__(4568);
const CpFileError = __nccwpck_require__(8634);

const stat = promisify(fs.stat);
const lstat = promisify(fs.lstat);
const utimes = promisify(fs.utimes);
const chmod = promisify(fs.chmod);
const chown = promisify(fs.chown);

exports.closeSync = fs.closeSync.bind(fs);
exports.createWriteStream = fs.createWriteStream.bind(fs);

exports.createReadStream = async (path, options) => {
	const read = fs.createReadStream(path, options);

	try {
		await pEvent(read, ['readable', 'end']);
	} catch (error) {
		throw new CpFileError(`Cannot read from \`${path}\`: ${error.message}`, error);
	}

	return read;
};

exports.stat = path => stat(path).catch(error => {
	throw new CpFileError(`Cannot stat path \`${path}\`: ${error.message}`, error);
});

exports.lstat = path => lstat(path).catch(error => {
	throw new CpFileError(`lstat \`${path}\` failed: ${error.message}`, error);
});

exports.utimes = (path, atime, mtime) => utimes(path, atime, mtime).catch(error => {
	throw new CpFileError(`utimes \`${path}\` failed: ${error.message}`, error);
});

exports.chmod = (path, mode) => chmod(path, mode).catch(error => {
	throw new CpFileError(`chmod \`${path}\` failed: ${error.message}`, error);
});

exports.chown = (path, uid, gid) => chown(path, uid, gid).catch(error => {
	throw new CpFileError(`chown \`${path}\` failed: ${error.message}`, error);
});

exports.statSync = path => {
	try {
		return fs.statSync(path);
	} catch (error) {
		throw new CpFileError(`stat \`${path}\` failed: ${error.message}`, error);
	}
};

exports.utimesSync = (path, atime, mtime) => {
	try {
		return fs.utimesSync(path, atime, mtime);
	} catch (error) {
		throw new CpFileError(`utimes \`${path}\` failed: ${error.message}`, error);
	}
};

exports.chmodSync = (path, mode) => {
	try {
		return fs.chmodSync(path, mode);
	} catch (error) {
		throw new CpFileError(`chmod \`${path}\` failed: ${error.message}`, error);
	}
};

exports.chownSync = (path, uid, gid) => {
	try {
		return fs.chownSync(path, uid, gid);
	} catch (error) {
		throw new CpFileError(`chown \`${path}\` failed: ${error.message}`, error);
	}
};

exports.makeDir = path => makeDir(path, {fs}).catch(error => {
	throw new CpFileError(`Cannot create directory \`${path}\`: ${error.message}`, error);
});

exports.makeDirSync = path => {
	try {
		makeDir.sync(path, {fs});
	} catch (error) {
		throw new CpFileError(`Cannot create directory \`${path}\`: ${error.message}`, error);
	}
};

exports.copyFileSync = (source, destination, flags) => {
	try {
		fs.copyFileSync(source, destination, flags);
	} catch (error) {
		throw new CpFileError(`Cannot copy from \`${source}\` to \`${destination}\`: ${error.message}`, error);
	}
};


/***/ }),

/***/ 4544:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {


const path = __nccwpck_require__(1017);
const {constants: fsConstants} = __nccwpck_require__(7147);
const pEvent = __nccwpck_require__(4568);
const CpFileError = __nccwpck_require__(8634);
const fs = __nccwpck_require__(6312);
const ProgressEmitter = __nccwpck_require__(1890);

const cpFileAsync = async (source, destination, options, progressEmitter) => {
	let readError;
	const stat = await fs.stat(source);
	progressEmitter.size = stat.size;

	const read = await fs.createReadStream(source);
	await fs.makeDir(path.dirname(destination));
	const write = fs.createWriteStream(destination, {flags: options.overwrite ? 'w' : 'wx'});
	read.on('data', () => {
		progressEmitter.written = write.bytesWritten;
	});
	read.once('error', error => {
		readError = new CpFileError(`Cannot read from \`${source}\`: ${error.message}`, error);
		write.end();
	});

	let updateStats = false;
	try {
		const writePromise = pEvent(write, 'close');
		read.pipe(write);
		await writePromise;
		progressEmitter.written = progressEmitter.size;
		updateStats = true;
	} catch (error) {
		if (options.overwrite || error.code !== 'EEXIST') {
			throw new CpFileError(`Cannot write to \`${destination}\`: ${error.message}`, error);
		}
	}

	if (readError) {
		throw readError;
	}

	if (updateStats) {
		const stats = await fs.lstat(source);

		return Promise.all([
			fs.utimes(destination, stats.atime, stats.mtime),
			fs.chmod(destination, stats.mode),
			fs.chown(destination, stats.uid, stats.gid)
		]);
	}
};

const cpFile = (source, destination, options) => {
	if (!source || !destination) {
		return Promise.reject(new CpFileError('`source` and `destination` required'));
	}

	options = {
		overwrite: true,
		...options
	};

	const progressEmitter = new ProgressEmitter(path.resolve(source), path.resolve(destination));
	const promise = cpFileAsync(source, destination, options, progressEmitter);
	promise.on = (...args) => {
		progressEmitter.on(...args);
		return promise;
	};

	return promise;
};

module.exports = cpFile;

const checkSourceIsFile = (stat, source) => {
	if (stat.isDirectory()) {
		throw Object.assign(new CpFileError(`EISDIR: illegal operation on a directory '${source}'`), {
			errno: -21,
			code: 'EISDIR',
			source
		});
	}
};

const fixupAttributes = (destination, stat) => {
	fs.chmodSync(destination, stat.mode);
	fs.chownSync(destination, stat.uid, stat.gid);
};

module.exports.sync = (source, destination, options) => {
	if (!source || !destination) {
		throw new CpFileError('`source` and `destination` required');
	}

	options = {
		overwrite: true,
		...options
	};

	const stat = fs.statSync(source);
	checkSourceIsFile(stat, source);
	fs.makeDirSync(path.dirname(destination));

	const flags = options.overwrite ? null : fsConstants.COPYFILE_EXCL;
	try {
		fs.copyFileSync(source, destination, flags);
	} catch (error) {
		if (!options.overwrite && error.code === 'EEXIST') {
			return;
		}

		throw error;
	}

	fs.utimesSync(destination, stat.atime, stat.mtime);
	fixupAttributes(destination, stat);
};


/***/ }),

/***/ 1890:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {


const EventEmitter = __nccwpck_require__(2361);

const written = new WeakMap();

class ProgressEmitter extends EventEmitter {
	constructor(source, destination) {
		super();
		this._source = source;
		this._destination = destination;
	}

	set written(value) {
		written.set(this, value);
		this.emitProgress();
	}

	get written() {
		return written.get(this);
	}

	emitProgress() {
		const {size, written} = this;
		this.emit('progress', {
			src: this._source,
			dest: this._destination,
			size,
			written,
			percent: written === size ? 1 : written / size
		});
	}
}

module.exports = ProgressEmitter;


/***/ }),

/***/ 9168:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {


const NestedError = __nccwpck_require__(7978);

class CpyError extends NestedError {
	constructor(message, nested) {
		super(message, nested);
		Object.assign(this, nested);
		this.name = 'CpyError';
	}
}

module.exports = CpyError;


/***/ }),

/***/ 4070:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {


const EventEmitter = __nccwpck_require__(2361);
const path = __nccwpck_require__(1017);
const os = __nccwpck_require__(2037);
const pMap = __nccwpck_require__(9201);
const arrify = __nccwpck_require__(1546);
const globby = __nccwpck_require__(3398);
const hasGlob = __nccwpck_require__(9562);
const cpFile = __nccwpck_require__(4544);
const junk = __nccwpck_require__(4072);
const pFilter = __nccwpck_require__(5886);
const CpyError = __nccwpck_require__(9168);

const defaultOptions = {
	ignoreJunk: true
};

class SourceFile {
	constructor(relativePath, path) {
		this.path = path;
		this.relativePath = relativePath;
		Object.freeze(this);
	}

	get name() {
		return path.basename(this.relativePath);
	}

	get nameWithoutExtension() {
		return path.basename(this.relativePath, path.extname(this.relativePath));
	}

	get extension() {
		return path.extname(this.relativePath).slice(1);
	}
}

const preprocessSourcePath = (source, options) => path.resolve(options.cwd ? options.cwd : process.cwd(), source);

const preprocessDestinationPath = (source, destination, options) => {
	let basename = path.basename(source);

	if (typeof options.rename === 'string') {
		basename = options.rename;
	} else if (typeof options.rename === 'function') {
		basename = options.rename(basename);
	}

	if (options.cwd) {
		destination = path.resolve(options.cwd, destination);
	}

	if (options.parents) {
		const dirname = path.dirname(source);
		const parsedDirectory = path.parse(dirname);
		return path.join(destination, dirname.replace(parsedDirectory.root, path.sep), basename);
	}

	return path.join(destination, basename);
};

module.exports = (source, destination, {
	concurrency = (os.cpus().length || 1) * 2,
	...options
} = {}) => {
	const progressEmitter = new EventEmitter();

	options = {
		...defaultOptions,
		...options
	};

	const promise = (async () => {
		source = arrify(source);

		if (source.length === 0 || !destination) {
			throw new CpyError('`source` and `destination` required');
		}

		const copyStatus = new Map();
		let completedFiles = 0;
		let completedSize = 0;

		let files;
		try {
			files = await globby(source, options);

			if (options.ignoreJunk) {
				files = files.filter(file => junk.not(path.basename(file)));
			}
		} catch (error) {
			throw new CpyError(`Cannot glob \`${source}\`: ${error.message}`, error);
		}

		if (files.length === 0 && !hasGlob(source)) {
			throw new CpyError(`Cannot copy \`${source}\`: the file doesn't exist`);
		}

		let sources = files.map(sourcePath => new SourceFile(sourcePath, preprocessSourcePath(sourcePath, options)));

		if (options.filter !== undefined) {
			const filteredSources = await pFilter(sources, options.filter, {concurrency: 1024});
			sources = filteredSources;
		}

		if (sources.length === 0) {
			progressEmitter.emit('progress', {
				totalFiles: 0,
				percent: 1,
				completedFiles: 0,
				completedSize: 0
			});
		}

		const fileProgressHandler = event => {
			const fileStatus = copyStatus.get(event.src) || {written: 0, percent: 0};

			if (fileStatus.written !== event.written || fileStatus.percent !== event.percent) {
				completedSize -= fileStatus.written;
				completedSize += event.written;

				if (event.percent === 1 && fileStatus.percent !== 1) {
					completedFiles++;
				}

				copyStatus.set(event.src, {
					written: event.written,
					percent: event.percent
				});

				progressEmitter.emit('progress', {
					totalFiles: files.length,
					percent: completedFiles / files.length,
					completedFiles,
					completedSize
				});
			}
		};

		return pMap(sources, async source => {
			const to = preprocessDestinationPath(source.relativePath, destination, options);

			try {
				await cpFile(source.path, to, options).on('progress', fileProgressHandler);
			} catch (error) {
				throw new CpyError(`Cannot copy from \`${source.relativePath}\` to \`${to}\`: ${error.message}`, error);
			}

			return to;
		}, {concurrency});
	})();

	promise.on = (...arguments_) => {
		progressEmitter.on(...arguments_);
		return promise;
	};

	return promise;
};


/***/ }),

/***/ 9201:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {


const AggregateError = __nccwpck_require__(1231);

module.exports = async (
	iterable,
	mapper,
	{
		concurrency = Infinity,
		stopOnError = true
	} = {}
) => {
	return new Promise((resolve, reject) => {
		if (typeof mapper !== 'function') {
			throw new TypeError('Mapper function is required');
		}

		if (!(typeof concurrency === 'number' && concurrency >= 1)) {
			throw new TypeError(`Expected \`concurrency\` to be a number from 1 and up, got \`${concurrency}\` (${typeof concurrency})`);
		}

		const ret = [];
		const errors = [];
		const iterator = iterable[Symbol.iterator]();
		let isRejected = false;
		let isIterableDone = false;
		let resolvingCount = 0;
		let currentIndex = 0;

		const next = () => {
			if (isRejected) {
				return;
			}

			const nextItem = iterator.next();
			const i = currentIndex;
			currentIndex++;

			if (nextItem.done) {
				isIterableDone = true;

				if (resolvingCount === 0) {
					if (!stopOnError && errors.length !== 0) {
						reject(new AggregateError(errors));
					} else {
						resolve(ret);
					}
				}

				return;
			}

			resolvingCount++;

			(async () => {
				try {
					const element = await nextItem.value;
					ret[i] = await mapper(element, i);
					resolvingCount--;
					next();
				} catch (error) {
					if (stopOnError) {
						isRejected = true;
						reject(error);
					} else {
						errors.push(error);
						resolvingCount--;
						next();
					}
				}
			})();
		};

		for (let i = 0; i < concurrency; i++) {
			next();

			if (isIterableDone) {
				break;
			}
		}
	});
};


/***/ }),

/***/ 8222:
/***/ ((module, exports, __nccwpck_require__) => {

/**
 * This is the web browser implementation of `debug()`.
 *
 * Expose `debug()` as the module.
 */

exports = module.exports = __nccwpck_require__(8564);
exports.log = log;
exports.formatArgs = formatArgs;
exports.save = save;
exports.load = load;
exports.useColors = useColors;
exports.storage = 'undefined' != typeof chrome
               && 'undefined' != typeof chrome.storage
                  ? chrome.storage.local
                  : localstorage();

/**
 * Colors.
 */

exports.colors = [
  'lightseagreen',
  'forestgreen',
  'goldenrod',
  'dodgerblue',
  'darkorchid',
  'crimson'
];

/**
 * Currently only WebKit-based Web Inspectors, Firefox >= v31,
 * and the Firebug extension (any Firefox version) are known
 * to support "%c" CSS customizations.
 *
 * TODO: add a `localStorage` variable to explicitly enable/disable colors
 */

function useColors() {
  // NB: In an Electron preload script, document will be defined but not fully
  // initialized. Since we know we're in Chrome, we'll just detect this case
  // explicitly
  if (typeof window !== 'undefined' && window.process && window.process.type === 'renderer') {
    return true;
  }

  // is webkit? http://stackoverflow.com/a/16459606/376773
  // document is undefined in react-native: https://github.com/facebook/react-native/pull/1632
  return (typeof document !== 'undefined' && document.documentElement && document.documentElement.style && document.documentElement.style.WebkitAppearance) ||
    // is firebug? http://stackoverflow.com/a/398120/376773
    (typeof window !== 'undefined' && window.console && (window.console.firebug || (window.console.exception && window.console.table))) ||
    // is firefox >= v31?
    // https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
    (typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/) && parseInt(RegExp.$1, 10) >= 31) ||
    // double check webkit in userAgent just in case we are in a worker
    (typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.toLowerCase().match(/applewebkit\/(\d+)/));
}

/**
 * Map %j to `JSON.stringify()`, since no Web Inspectors do that by default.
 */

exports.formatters.j = function(v) {
  try {
    return JSON.stringify(v);
  } catch (err) {
    return '[UnexpectedJSONParseError]: ' + err.message;
  }
};


/**
 * Colorize log arguments if enabled.
 *
 * @api public
 */

function formatArgs(args) {
  var useColors = this.useColors;

  args[0] = (useColors ? '%c' : '')
    + this.namespace
    + (useColors ? ' %c' : ' ')
    + args[0]
    + (useColors ? '%c ' : ' ')
    + '+' + exports.humanize(this.diff);

  if (!useColors) return;

  var c = 'color: ' + this.color;
  args.splice(1, 0, c, 'color: inherit')

  // the final "%c" is somewhat tricky, because there could be other
  // arguments passed either before or after the %c, so we need to
  // figure out the correct index to insert the CSS into
  var index = 0;
  var lastC = 0;
  args[0].replace(/%[a-zA-Z%]/g, function(match) {
    if ('%%' === match) return;
    index++;
    if ('%c' === match) {
      // we only are interested in the *last* %c
      // (the user may have provided their own)
      lastC = index;
    }
  });

  args.splice(lastC, 0, c);
}

/**
 * Invokes `console.log()` when available.
 * No-op when `console.log` is not a "function".
 *
 * @api public
 */

function log() {
  // this hackery is required for IE8/9, where
  // the `console.log` function doesn't have 'apply'
  return 'object' === typeof console
    && console.log
    && Function.prototype.apply.call(console.log, console, arguments);
}

/**
 * Save `namespaces`.
 *
 * @param {String} namespaces
 * @api private
 */

function save(namespaces) {
  try {
    if (null == namespaces) {
      exports.storage.removeItem('debug');
    } else {
      exports.storage.debug = namespaces;
    }
  } catch(e) {}
}

/**
 * Load `namespaces`.
 *
 * @return {String} returns the previously persisted debug modes
 * @api private
 */

function load() {
  var r;
  try {
    r = exports.storage.debug;
  } catch(e) {}

  // If debug isn't set in LS, and we're in Electron, try to load $DEBUG
  if (!r && typeof process !== 'undefined' && 'env' in process) {
    r = process.env.DEBUG;
  }

  return r;
}

/**
 * Enable namespaces listed in `localStorage.debug` initially.
 */

exports.enable(load());

/**
 * Localstorage attempts to return the localstorage.
 *
 * This is necessary because safari throws
 * when a user disables cookies/localstorage
 * and you attempt to access it.
 *
 * @return {LocalStorage}
 * @api private
 */

function localstorage() {
  try {
    return window.localStorage;
  } catch (e) {}
}


/***/ }),

/***/ 8564:
/***/ ((module, exports, __nccwpck_require__) => {


/**
 * This is the common logic for both the Node.js and web browser
 * implementations of `debug()`.
 *
 * Expose `debug()` as the module.
 */

exports = module.exports = createDebug.debug = createDebug['default'] = createDebug;
exports.coerce = coerce;
exports.disable = disable;
exports.enable = enable;
exports.enabled = enabled;
exports.humanize = __nccwpck_require__(900);

/**
 * The currently active debug mode names, and names to skip.
 */

exports.names = [];
exports.skips = [];

/**
 * Map of special "%n" handling functions, for the debug "format" argument.
 *
 * Valid key names are a single, lower or upper-case letter, i.e. "n" and "N".
 */

exports.formatters = {};

/**
 * Previous log timestamp.
 */

var prevTime;

/**
 * Select a color.
 * @param {String} namespace
 * @return {Number}
 * @api private
 */

function selectColor(namespace) {
  var hash = 0, i;

  for (i in namespace) {
    hash  = ((hash << 5) - hash) + namespace.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }

  return exports.colors[Math.abs(hash) % exports.colors.length];
}

/**
 * Create a debugger with the given `namespace`.
 *
 * @param {String} namespace
 * @return {Function}
 * @api public
 */

function createDebug(namespace) {

  function debug() {
    // disabled?
    if (!debug.enabled) return;

    var self = debug;

    // set `diff` timestamp
    var curr = +new Date();
    var ms = curr - (prevTime || curr);
    self.diff = ms;
    self.prev = prevTime;
    self.curr = curr;
    prevTime = curr;

    // turn the `arguments` into a proper Array
    var args = new Array(arguments.length);
    for (var i = 0; i < args.length; i++) {
      args[i] = arguments[i];
    }

    args[0] = exports.coerce(args[0]);

    if ('string' !== typeof args[0]) {
      // anything else let's inspect with %O
      args.unshift('%O');
    }

    // apply any `formatters` transformations
    var index = 0;
    args[0] = args[0].replace(/%([a-zA-Z%])/g, function(match, format) {
      // if we encounter an escaped % then don't increase the array index
      if (match === '%%') return match;
      index++;
      var formatter = exports.formatters[format];
      if ('function' === typeof formatter) {
        var val = args[index];
        match = formatter.call(self, val);

        // now we need to remove `args[index]` since it's inlined in the `format`
        args.splice(index, 1);
        index--;
      }
      return match;
    });

    // apply env-specific formatting (colors, etc.)
    exports.formatArgs.call(self, args);

    var logFn = debug.log || exports.log || console.log.bind(console);
    logFn.apply(self, args);
  }

  debug.namespace = namespace;
  debug.enabled = exports.enabled(namespace);
  debug.useColors = exports.useColors();
  debug.color = selectColor(namespace);

  // env-specific initialization logic for debug instances
  if ('function' === typeof exports.init) {
    exports.init(debug);
  }

  return debug;
}

/**
 * Enables a debug mode by namespaces. This can include modes
 * separated by a colon and wildcards.
 *
 * @param {String} namespaces
 * @api public
 */

function enable(namespaces) {
  exports.save(namespaces);

  exports.names = [];
  exports.skips = [];

  var split = (typeof namespaces === 'string' ? namespaces : '').split(/[\s,]+/);
  var len = split.length;

  for (var i = 0; i < len; i++) {
    if (!split[i]) continue; // ignore empty strings
    namespaces = split[i].replace(/\*/g, '.*?');
    if (namespaces[0] === '-') {
      exports.skips.push(new RegExp('^' + namespaces.substr(1) + '$'));
    } else {
      exports.names.push(new RegExp('^' + namespaces + '$'));
    }
  }
}

/**
 * Disable debug output.
 *
 * @api public
 */

function disable() {
  exports.enable('');
}

/**
 * Returns true if the given mode name is enabled, false otherwise.
 *
 * @param {String} name
 * @return {Boolean}
 * @api public
 */

function enabled(name) {
  var i, len;
  for (i = 0, len = exports.skips.length; i < len; i++) {
    if (exports.skips[i].test(name)) {
      return false;
    }
  }
  for (i = 0, len = exports.names.length; i < len; i++) {
    if (exports.names[i].test(name)) {
      return true;
    }
  }
  return false;
}

/**
 * Coerce `val`.
 *
 * @param {Mixed} val
 * @return {Mixed}
 * @api private
 */

function coerce(val) {
  if (val instanceof Error) return val.stack || val.message;
  return val;
}


/***/ }),

/***/ 8237:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/**
 * Detect Electron renderer process, which is node, but we should
 * treat as a browser.
 */

if (typeof process !== 'undefined' && process.type === 'renderer') {
  module.exports = __nccwpck_require__(8222);
} else {
  module.exports = __nccwpck_require__(5332);
}


/***/ }),

/***/ 5332:
/***/ ((module, exports, __nccwpck_require__) => {

/**
 * Module dependencies.
 */

var tty = __nccwpck_require__(6224);
var util = __nccwpck_require__(3837);

/**
 * This is the Node.js implementation of `debug()`.
 *
 * Expose `debug()` as the module.
 */

exports = module.exports = __nccwpck_require__(8564);
exports.init = init;
exports.log = log;
exports.formatArgs = formatArgs;
exports.save = save;
exports.load = load;
exports.useColors = useColors;

/**
 * Colors.
 */

exports.colors = [6, 2, 3, 4, 5, 1];

/**
 * Build up the default `inspectOpts` object from the environment variables.
 *
 *   $ DEBUG_COLORS=no DEBUG_DEPTH=10 DEBUG_SHOW_HIDDEN=enabled node script.js
 */

exports.inspectOpts = Object.keys(process.env).filter(function (key) {
  return /^debug_/i.test(key);
}).reduce(function (obj, key) {
  // camel-case
  var prop = key
    .substring(6)
    .toLowerCase()
    .replace(/_([a-z])/g, function (_, k) { return k.toUpperCase() });

  // coerce string value into JS value
  var val = process.env[key];
  if (/^(yes|on|true|enabled)$/i.test(val)) val = true;
  else if (/^(no|off|false|disabled)$/i.test(val)) val = false;
  else if (val === 'null') val = null;
  else val = Number(val);

  obj[prop] = val;
  return obj;
}, {});

/**
 * The file descriptor to write the `debug()` calls to.
 * Set the `DEBUG_FD` env variable to override with another value. i.e.:
 *
 *   $ DEBUG_FD=3 node script.js 3>debug.log
 */

var fd = parseInt(process.env.DEBUG_FD, 10) || 2;

if (1 !== fd && 2 !== fd) {
  util.deprecate(function(){}, 'except for stderr(2) and stdout(1), any other usage of DEBUG_FD is deprecated. Override debug.log if you want to use a different log function (https://git.io/debug_fd)')()
}

var stream = 1 === fd ? process.stdout :
             2 === fd ? process.stderr :
             createWritableStdioStream(fd);

/**
 * Is stdout a TTY? Colored output is enabled when `true`.
 */

function useColors() {
  return 'colors' in exports.inspectOpts
    ? Boolean(exports.inspectOpts.colors)
    : tty.isatty(fd);
}

/**
 * Map %o to `util.inspect()`, all on a single line.
 */

exports.formatters.o = function(v) {
  this.inspectOpts.colors = this.useColors;
  return util.inspect(v, this.inspectOpts)
    .split('\n').map(function(str) {
      return str.trim()
    }).join(' ');
};

/**
 * Map %o to `util.inspect()`, allowing multiple lines if needed.
 */

exports.formatters.O = function(v) {
  this.inspectOpts.colors = this.useColors;
  return util.inspect(v, this.inspectOpts);
};

/**
 * Adds ANSI color escape codes if enabled.
 *
 * @api public
 */

function formatArgs(args) {
  var name = this.namespace;
  var useColors = this.useColors;

  if (useColors) {
    var c = this.color;
    var prefix = '  \u001b[3' + c + ';1m' + name + ' ' + '\u001b[0m';

    args[0] = prefix + args[0].split('\n').join('\n' + prefix);
    args.push('\u001b[3' + c + 'm+' + exports.humanize(this.diff) + '\u001b[0m');
  } else {
    args[0] = new Date().toUTCString()
      + ' ' + name + ' ' + args[0];
  }
}

/**
 * Invokes `util.format()` with the specified arguments and writes to `stream`.
 */

function log() {
  return stream.write(util.format.apply(util, arguments) + '\n');
}

/**
 * Save `namespaces`.
 *
 * @param {String} namespaces
 * @api private
 */

function save(namespaces) {
  if (null == namespaces) {
    // If you set a process.env field to null or undefined, it gets cast to the
    // string 'null' or 'undefined'. Just delete instead.
    delete process.env.DEBUG;
  } else {
    process.env.DEBUG = namespaces;
  }
}

/**
 * Load `namespaces`.
 *
 * @return {String} returns the previously persisted debug modes
 * @api private
 */

function load() {
  return process.env.DEBUG;
}

/**
 * Copied from `node/src/node.js`.
 *
 * XXX: It's lame that node doesn't expose this API out-of-the-box. It also
 * relies on the undocumented `tty_wrap.guessHandleType()` which is also lame.
 */

function createWritableStdioStream (fd) {
  var stream;
  var tty_wrap = process.binding('tty_wrap');

  // Note stream._type is used for test-module-load-list.js

  switch (tty_wrap.guessHandleType(fd)) {
    case 'TTY':
      stream = new tty.WriteStream(fd);
      stream._type = 'tty';

      // Hack to have stream not keep the event loop alive.
      // See https://github.com/joyent/node/issues/1726
      if (stream._handle && stream._handle.unref) {
        stream._handle.unref();
      }
      break;

    case 'FILE':
      var fs = __nccwpck_require__(7147);
      stream = new fs.SyncWriteStream(fd, { autoClose: false });
      stream._type = 'fs';
      break;

    case 'PIPE':
    case 'TCP':
      var net = __nccwpck_require__(1808);
      stream = new net.Socket({
        fd: fd,
        readable: false,
        writable: true
      });

      // FIXME Should probably have an option in net.Socket to create a
      // stream from an existing fd which is writable only. But for now
      // we'll just add this hack and set the `readable` member to false.
      // Test: ./node test/fixtures/echo.js < /etc/passwd
      stream.readable = false;
      stream.read = null;
      stream._type = 'pipe';

      // FIXME Hack to have stream not keep the event loop alive.
      // See https://github.com/joyent/node/issues/1726
      if (stream._handle && stream._handle.unref) {
        stream._handle.unref();
      }
      break;

    default:
      // Probably an error on in uv_guess_handle()
      throw new Error('Implement me. Unknown stream file type!');
  }

  // For supporting legacy API we put the FD here.
  stream.fd = fd;

  stream._isStdio = true;

  return stream;
}

/**
 * Init logic for `debug` instances.
 *
 * Create a new `inspectOpts` object in case `useColors` is set
 * differently for a particular `debug` instance.
 */

function init (debug) {
  debug.inspectOpts = {};

  var keys = Object.keys(exports.inspectOpts);
  for (var i = 0; i < keys.length; i++) {
    debug.inspectOpts[keys[i]] = exports.inspectOpts[keys[i]];
  }
}

/**
 * Enable namespaces listed in `process.env.DEBUG` initially.
 */

exports.enable(load());


/***/ }),

/***/ 3186:
/***/ ((module) => {


var token = '%[a-f0-9]{2}';
var singleMatcher = new RegExp(token, 'gi');
var multiMatcher = new RegExp('(' + token + ')+', 'gi');

function decodeComponents(components, split) {
	try {
		// Try to decode the entire string first
		return decodeURIComponent(components.join(''));
	} catch (err) {
		// Do nothing
	}

	if (components.length === 1) {
		return components;
	}

	split = split || 1;

	// Split the array in 2 parts
	var left = components.slice(0, split);
	var right = components.slice(split);

	return Array.prototype.concat.call([], decodeComponents(left), decodeComponents(right));
}

function decode(input) {
	try {
		return decodeURIComponent(input);
	} catch (err) {
		var tokens = input.match(singleMatcher);

		for (var i = 1; i < tokens.length; i++) {
			input = decodeComponents(tokens, i).join('');

			tokens = input.match(singleMatcher);
		}

		return input;
	}
}

function customDecodeURIComponent(input) {
	// Keep track of all the replacements and prefill the map with the `BOM`
	var replaceMap = {
		'%FE%FF': '\uFFFD\uFFFD',
		'%FF%FE': '\uFFFD\uFFFD'
	};

	var match = multiMatcher.exec(input);
	while (match) {
		try {
			// Decode as big chunks as possible
			replaceMap[match[0]] = decodeURIComponent(match[0]);
		} catch (err) {
			var result = decode(match[0]);

			if (result !== match[0]) {
				replaceMap[match[0]] = result;
			}
		}

		match = multiMatcher.exec(input);
	}

	// Add `%C2` at the end of the map to make sure it does not replace the combinator before everything else
	replaceMap['%C2'] = '\uFFFD';

	var entries = Object.keys(replaceMap);

	for (var i = 0; i < entries.length; i++) {
		// Replace all decoded components
		var key = entries[i];
		input = input.replace(new RegExp(key, 'g'), replaceMap[key]);
	}

	return input;
}

module.exports = function (encodedURI) {
	if (typeof encodedURI !== 'string') {
		throw new TypeError('Expected `encodedURI` to be of type `string`, got `' + typeof encodedURI + '`');
	}

	try {
		encodedURI = encodedURI.replace(/\+/g, ' ');

		// Try the built in decoder first
		return decodeURIComponent(encodedURI);
	} catch (err) {
		// Fallback to a more advanced decoder
		return customDecodeURIComponent(encodedURI);
	}
};


/***/ }),

/***/ 6967:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * define-property <https://github.com/jonschlinkert/define-property>
 *
 * Copyright (c) 2015, Jon Schlinkert.
 * Licensed under the MIT License.
 */



var isDescriptor = __nccwpck_require__(5530);

module.exports = function defineProperty(obj, prop, val) {
  if (typeof obj !== 'object' && typeof obj !== 'function') {
    throw new TypeError('expected an object or function.');
  }

  if (typeof prop !== 'string') {
    throw new TypeError('expected `prop` to be a string.');
  }

  if (isDescriptor(val) && ('set' in val || 'get' in val)) {
    return Object.defineProperty(obj, prop, val);
  }

  return Object.defineProperty(obj, prop, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: val
  });
};


/***/ }),

/***/ 2774:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * is-accessor-descriptor <https://github.com/jonschlinkert/is-accessor-descriptor>
 *
 * Copyright (c) 2015, Jon Schlinkert.
 * Licensed under the MIT License.
 */



var typeOf = __nccwpck_require__(2813);

// accessor descriptor properties
var accessor = {
  get: 'function',
  set: 'function',
  configurable: 'boolean',
  enumerable: 'boolean'
};

function isAccessorDescriptor(obj, prop) {
  if (typeof prop === 'string') {
    var val = Object.getOwnPropertyDescriptor(obj, prop);
    return typeof val !== 'undefined';
  }

  if (typeOf(obj) !== 'object') {
    return false;
  }

  if (has(obj, 'value') || has(obj, 'writable')) {
    return false;
  }

  if (!has(obj, 'get') || typeof obj.get !== 'function') {
    return false;
  }

  // tldr: it's valid to have "set" be undefined
  // "set" might be undefined if `Object.getOwnPropertyDescriptor`
  // was used to get the value, and only `get` was defined by the user
  if (has(obj, 'set') && typeof obj[key] !== 'function' && typeof obj[key] !== 'undefined') {
    return false;
  }

  for (var key in obj) {
    if (!accessor.hasOwnProperty(key)) {
      continue;
    }

    if (typeOf(obj[key]) === accessor[key]) {
      continue;
    }

    if (typeof obj[key] !== 'undefined') {
      return false;
    }
  }
  return true;
}

function has(obj, key) {
  return {}.hasOwnProperty.call(obj, key);
}

/**
 * Expose `isAccessorDescriptor`
 */

module.exports = isAccessorDescriptor;


/***/ }),

/***/ 2813:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

var isBuffer = __nccwpck_require__(5625);
var toString = Object.prototype.toString;

/**
 * Get the native `typeof` a value.
 *
 * @param  {*} `val`
 * @return {*} Native javascript type
 */

module.exports = function kindOf(val) {
  // primitivies
  if (typeof val === 'undefined') {
    return 'undefined';
  }
  if (val === null) {
    return 'null';
  }
  if (val === true || val === false || val instanceof Boolean) {
    return 'boolean';
  }
  if (typeof val === 'string' || val instanceof String) {
    return 'string';
  }
  if (typeof val === 'number' || val instanceof Number) {
    return 'number';
  }

  // functions
  if (typeof val === 'function' || val instanceof Function) {
    return 'function';
  }

  // array
  if (typeof Array.isArray !== 'undefined' && Array.isArray(val)) {
    return 'array';
  }

  // check for instances of RegExp and Date before calling `toString`
  if (val instanceof RegExp) {
    return 'regexp';
  }
  if (val instanceof Date) {
    return 'date';
  }

  // other objects
  var type = toString.call(val);

  if (type === '[object RegExp]') {
    return 'regexp';
  }
  if (type === '[object Date]') {
    return 'date';
  }
  if (type === '[object Arguments]') {
    return 'arguments';
  }
  if (type === '[object Error]') {
    return 'error';
  }

  // buffer
  if (isBuffer(val)) {
    return 'buffer';
  }

  // es6: Map, WeakMap, Set, WeakSet
  if (type === '[object Set]') {
    return 'set';
  }
  if (type === '[object WeakSet]') {
    return 'weakset';
  }
  if (type === '[object Map]') {
    return 'map';
  }
  if (type === '[object WeakMap]') {
    return 'weakmap';
  }
  if (type === '[object Symbol]') {
    return 'symbol';
  }

  // typed arrays
  if (type === '[object Int8Array]') {
    return 'int8array';
  }
  if (type === '[object Uint8Array]') {
    return 'uint8array';
  }
  if (type === '[object Uint8ClampedArray]') {
    return 'uint8clampedarray';
  }
  if (type === '[object Int16Array]') {
    return 'int16array';
  }
  if (type === '[object Uint16Array]') {
    return 'uint16array';
  }
  if (type === '[object Int32Array]') {
    return 'int32array';
  }
  if (type === '[object Uint32Array]') {
    return 'uint32array';
  }
  if (type === '[object Float32Array]') {
    return 'float32array';
  }
  if (type === '[object Float64Array]') {
    return 'float64array';
  }

  // must be a plain object
  return 'object';
};


/***/ }),

/***/ 6013:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * is-data-descriptor <https://github.com/jonschlinkert/is-data-descriptor>
 *
 * Copyright (c) 2015, Jon Schlinkert.
 * Licensed under the MIT License.
 */



var typeOf = __nccwpck_require__(8190);

// data descriptor properties
var data = {
  configurable: 'boolean',
  enumerable: 'boolean',
  writable: 'boolean'
};

function isDataDescriptor(obj, prop) {
  if (typeOf(obj) !== 'object') {
    return false;
  }

  if (typeof prop === 'string') {
    var val = Object.getOwnPropertyDescriptor(obj, prop);
    return typeof val !== 'undefined';
  }

  if (!('value' in obj) && !('writable' in obj)) {
    return false;
  }

  for (var key in obj) {
    if (key === 'value') continue;

    if (!data.hasOwnProperty(key)) {
      continue;
    }

    if (typeOf(obj[key]) === data[key]) {
      continue;
    }

    if (typeof obj[key] !== 'undefined') {
      return false;
    }
  }
  return true;
}

/**
 * Expose `isDataDescriptor`
 */

module.exports = isDataDescriptor;


/***/ }),

/***/ 8190:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

var isBuffer = __nccwpck_require__(5625);
var toString = Object.prototype.toString;

/**
 * Get the native `typeof` a value.
 *
 * @param  {*} `val`
 * @return {*} Native javascript type
 */

module.exports = function kindOf(val) {
  // primitivies
  if (typeof val === 'undefined') {
    return 'undefined';
  }
  if (val === null) {
    return 'null';
  }
  if (val === true || val === false || val instanceof Boolean) {
    return 'boolean';
  }
  if (typeof val === 'string' || val instanceof String) {
    return 'string';
  }
  if (typeof val === 'number' || val instanceof Number) {
    return 'number';
  }

  // functions
  if (typeof val === 'function' || val instanceof Function) {
    return 'function';
  }

  // array
  if (typeof Array.isArray !== 'undefined' && Array.isArray(val)) {
    return 'array';
  }

  // check for instances of RegExp and Date before calling `toString`
  if (val instanceof RegExp) {
    return 'regexp';
  }
  if (val instanceof Date) {
    return 'date';
  }

  // other objects
  var type = toString.call(val);

  if (type === '[object RegExp]') {
    return 'regexp';
  }
  if (type === '[object Date]') {
    return 'date';
  }
  if (type === '[object Arguments]') {
    return 'arguments';
  }
  if (type === '[object Error]') {
    return 'error';
  }

  // buffer
  if (isBuffer(val)) {
    return 'buffer';
  }

  // es6: Map, WeakMap, Set, WeakSet
  if (type === '[object Set]') {
    return 'set';
  }
  if (type === '[object WeakSet]') {
    return 'weakset';
  }
  if (type === '[object Map]') {
    return 'map';
  }
  if (type === '[object WeakMap]') {
    return 'weakmap';
  }
  if (type === '[object Symbol]') {
    return 'symbol';
  }

  // typed arrays
  if (type === '[object Int8Array]') {
    return 'int8array';
  }
  if (type === '[object Uint8Array]') {
    return 'uint8array';
  }
  if (type === '[object Uint8ClampedArray]') {
    return 'uint8clampedarray';
  }
  if (type === '[object Int16Array]') {
    return 'int16array';
  }
  if (type === '[object Uint16Array]') {
    return 'uint16array';
  }
  if (type === '[object Int32Array]') {
    return 'int32array';
  }
  if (type === '[object Uint32Array]') {
    return 'uint32array';
  }
  if (type === '[object Float32Array]') {
    return 'float32array';
  }
  if (type === '[object Float64Array]') {
    return 'float64array';
  }

  // must be a plain object
  return 'object';
};


/***/ }),

/***/ 5530:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * is-descriptor <https://github.com/jonschlinkert/is-descriptor>
 *
 * Copyright (c) 2015-2017, Jon Schlinkert.
 * Released under the MIT License.
 */



var typeOf = __nccwpck_require__(146);
var isAccessor = __nccwpck_require__(2774);
var isData = __nccwpck_require__(6013);

module.exports = function isDescriptor(obj, key) {
  if (typeOf(obj) !== 'object') {
    return false;
  }
  if ('get' in obj) {
    return isAccessor(obj, key);
  }
  return isData(obj, key);
};


/***/ }),

/***/ 146:
/***/ ((module) => {

var toString = Object.prototype.toString;

/**
 * Get the native `typeof` a value.
 *
 * @param  {*} `val`
 * @return {*} Native javascript type
 */

module.exports = function kindOf(val) {
  var type = typeof val;

  // primitivies
  if (type === 'undefined') {
    return 'undefined';
  }
  if (val === null) {
    return 'null';
  }
  if (val === true || val === false || val instanceof Boolean) {
    return 'boolean';
  }
  if (type === 'string' || val instanceof String) {
    return 'string';
  }
  if (type === 'number' || val instanceof Number) {
    return 'number';
  }

  // functions
  if (type === 'function' || val instanceof Function) {
    if (typeof val.constructor.name !== 'undefined' && val.constructor.name.slice(0, 9) === 'Generator') {
      return 'generatorfunction';
    }
    return 'function';
  }

  // array
  if (typeof Array.isArray !== 'undefined' && Array.isArray(val)) {
    return 'array';
  }

  // check for instances of RegExp and Date before calling `toString`
  if (val instanceof RegExp) {
    return 'regexp';
  }
  if (val instanceof Date) {
    return 'date';
  }

  // other objects
  type = toString.call(val);

  if (type === '[object RegExp]') {
    return 'regexp';
  }
  if (type === '[object Date]') {
    return 'date';
  }
  if (type === '[object Arguments]') {
    return 'arguments';
  }
  if (type === '[object Error]') {
    return 'error';
  }
  if (type === '[object Promise]') {
    return 'promise';
  }

  // buffer
  if (isBuffer(val)) {
    return 'buffer';
  }

  // es6: Map, WeakMap, Set, WeakSet
  if (type === '[object Set]') {
    return 'set';
  }
  if (type === '[object WeakSet]') {
    return 'weakset';
  }
  if (type === '[object Map]') {
    return 'map';
  }
  if (type === '[object WeakMap]') {
    return 'weakmap';
  }
  if (type === '[object Symbol]') {
    return 'symbol';
  }
  
  if (type === '[object Map Iterator]') {
    return 'mapiterator';
  }
  if (type === '[object Set Iterator]') {
    return 'setiterator';
  }
  if (type === '[object String Iterator]') {
    return 'stringiterator';
  }
  if (type === '[object Array Iterator]') {
    return 'arrayiterator';
  }
  
  // typed arrays
  if (type === '[object Int8Array]') {
    return 'int8array';
  }
  if (type === '[object Uint8Array]') {
    return 'uint8array';
  }
  if (type === '[object Uint8ClampedArray]') {
    return 'uint8clampedarray';
  }
  if (type === '[object Int16Array]') {
    return 'int16array';
  }
  if (type === '[object Uint16Array]') {
    return 'uint16array';
  }
  if (type === '[object Int32Array]') {
    return 'int32array';
  }
  if (type === '[object Uint32Array]') {
    return 'uint32array';
  }
  if (type === '[object Float32Array]') {
    return 'float32array';
  }
  if (type === '[object Float64Array]') {
    return 'float64array';
  }

  // must be a plain object
  return 'object';
};

/**
 * If you need to support Safari 5-7 (8-10 yr-old browser),
 * take a look at https://github.com/feross/is-buffer
 */

function isBuffer(val) {
  return val.constructor
    && typeof val.constructor.isBuffer === 'function'
    && val.constructor.isBuffer(val);
}


/***/ }),

/***/ 2738:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {


const path = __nccwpck_require__(1017);
const pathType = __nccwpck_require__(3433);

const getExtensions = extensions => extensions.length > 1 ? `{${extensions.join(',')}}` : extensions[0];

const getPath = (filepath, cwd) => {
	const pth = filepath[0] === '!' ? filepath.slice(1) : filepath;
	return path.isAbsolute(pth) ? pth : path.join(cwd, pth);
};

const addExtensions = (file, extensions) => {
	if (path.extname(file)) {
		return `**/${file}`;
	}

	return `**/${file}.${getExtensions(extensions)}`;
};

const getGlob = (dir, opts) => {
	if (opts.files && !Array.isArray(opts.files)) {
		throw new TypeError(`Expected \`files\` to be of type \`Array\` but received type \`${typeof opts.files}\``);
	}

	if (opts.extensions && !Array.isArray(opts.extensions)) {
		throw new TypeError(`Expected \`extensions\` to be of type \`Array\` but received type \`${typeof opts.extensions}\``);
	}

	if (opts.files && opts.extensions) {
		return opts.files.map(x => path.join(dir, addExtensions(x, opts.extensions)));
	}

	if (opts.files) {
		return opts.files.map(x => path.join(dir, `**/${x}`));
	}

	if (opts.extensions) {
		return [path.join(dir, `**/*.${getExtensions(opts.extensions)}`)];
	}

	return [path.join(dir, '**')];
};

module.exports = (input, opts) => {
	opts = Object.assign({cwd: process.cwd()}, opts);

	if (typeof opts.cwd !== 'string') {
		return Promise.reject(new TypeError(`Expected \`cwd\` to be of type \`string\` but received type \`${typeof opts.cwd}\``));
	}

	return Promise.all([].concat(input).map(x => pathType.dir(getPath(x, opts.cwd))
		.then(isDir => isDir ? getGlob(x, opts) : x)))
		.then(globs => [].concat.apply([], globs));
};

module.exports.sync = (input, opts) => {
	opts = Object.assign({cwd: process.cwd()}, opts);

	if (typeof opts.cwd !== 'string') {
		throw new TypeError(`Expected \`cwd\` to be of type \`string\` but received type \`${typeof opts.cwd}\``);
	}

	const globs = [].concat(input).map(x => pathType.dirSync(getPath(x, opts.cwd)) ? getGlob(x, opts) : x);
	return [].concat.apply([], globs);
};


/***/ }),

/***/ 5809:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



/**
 * Local dependencies
 */

var compilers = __nccwpck_require__(2647);
var parsers = __nccwpck_require__(8036);

/**
 * Module dependencies
 */

var debug = __nccwpck_require__(8237)('expand-brackets');
var extend = __nccwpck_require__(7512);
var Snapdragon = __nccwpck_require__(2403);
var toRegex = __nccwpck_require__(6855);

/**
 * Parses the given POSIX character class `pattern` and returns a
 * string that can be used for creating regular expressions for matching.
 *
 * @param {String} `pattern`
 * @param {Object} `options`
 * @return {Object}
 * @api public
 */

function brackets(pattern, options) {
  debug('initializing from <%s>', __filename);
  var res = brackets.create(pattern, options);
  return res.output;
}

/**
 * Takes an array of strings and a POSIX character class pattern, and returns a new
 * array with only the strings that matched the pattern.
 *
 * ```js
 * var brackets = require('expand-brackets');
 * console.log(brackets.match(['1', 'a', 'ab'], '[[:alpha:]]'));
 * //=> ['a']
 *
 * console.log(brackets.match(['1', 'a', 'ab'], '[[:alpha:]]+'));
 * //=> ['a', 'ab']
 * ```
 * @param {Array} `arr` Array of strings to match
 * @param {String} `pattern` POSIX character class pattern(s)
 * @param {Object} `options`
 * @return {Array}
 * @api public
 */

brackets.match = function(arr, pattern, options) {
  arr = [].concat(arr);
  var opts = extend({}, options);
  var isMatch = brackets.matcher(pattern, opts);
  var len = arr.length;
  var idx = -1;
  var res = [];

  while (++idx < len) {
    var ele = arr[idx];
    if (isMatch(ele)) {
      res.push(ele);
    }
  }

  if (res.length === 0) {
    if (opts.failglob === true) {
      throw new Error('no matches found for "' + pattern + '"');
    }

    if (opts.nonull === true || opts.nullglob === true) {
      return [pattern.split('\\').join('')];
    }
  }
  return res;
};

/**
 * Returns true if the specified `string` matches the given
 * brackets `pattern`.
 *
 * ```js
 * var brackets = require('expand-brackets');
 *
 * console.log(brackets.isMatch('a.a', '[[:alpha:]].[[:alpha:]]'));
 * //=> true
 * console.log(brackets.isMatch('1.2', '[[:alpha:]].[[:alpha:]]'));
 * //=> false
 * ```
 * @param {String} `string` String to match
 * @param {String} `pattern` Poxis pattern
 * @param {String} `options`
 * @return {Boolean}
 * @api public
 */

brackets.isMatch = function(str, pattern, options) {
  return brackets.matcher(pattern, options)(str);
};

/**
 * Takes a POSIX character class pattern and returns a matcher function. The returned
 * function takes the string to match as its only argument.
 *
 * ```js
 * var brackets = require('expand-brackets');
 * var isMatch = brackets.matcher('[[:lower:]].[[:upper:]]');
 *
 * console.log(isMatch('a.a'));
 * //=> false
 * console.log(isMatch('a.A'));
 * //=> true
 * ```
 * @param {String} `pattern` Poxis pattern
 * @param {String} `options`
 * @return {Boolean}
 * @api public
 */

brackets.matcher = function(pattern, options) {
  var re = brackets.makeRe(pattern, options);
  return function(str) {
    return re.test(str);
  };
};

/**
 * Create a regular expression from the given `pattern`.
 *
 * ```js
 * var brackets = require('expand-brackets');
 * var re = brackets.makeRe('[[:alpha:]]');
 * console.log(re);
 * //=> /^(?:[a-zA-Z])$/
 * ```
 * @param {String} `pattern` The pattern to convert to regex.
 * @param {Object} `options`
 * @return {RegExp}
 * @api public
 */

brackets.makeRe = function(pattern, options) {
  var res = brackets.create(pattern, options);
  var opts = extend({strictErrors: false}, options);
  return toRegex(res.output, opts);
};

/**
 * Parses the given POSIX character class `pattern` and returns an object
 * with the compiled `output` and optional source `map`.
 *
 * ```js
 * var brackets = require('expand-brackets');
 * console.log(brackets('[[:alpha:]]'));
 * // { options: { source: 'string' },
 * //   input: '[[:alpha:]]',
 * //   state: {},
 * //   compilers:
 * //    { eos: [Function],
 * //      noop: [Function],
 * //      bos: [Function],
 * //      not: [Function],
 * //      escape: [Function],
 * //      text: [Function],
 * //      posix: [Function],
 * //      bracket: [Function],
 * //      'bracket.open': [Function],
 * //      'bracket.inner': [Function],
 * //      'bracket.literal': [Function],
 * //      'bracket.close': [Function] },
 * //   output: '[a-zA-Z]',
 * //   ast:
 * //    { type: 'root',
 * //      errors: [],
 * //      nodes: [ [Object], [Object], [Object] ] },
 * //   parsingErrors: [] }
 * ```
 * @param {String} `pattern`
 * @param {Object} `options`
 * @return {Object}
 * @api public
 */

brackets.create = function(pattern, options) {
  var snapdragon = (options && options.snapdragon) || new Snapdragon(options);
  compilers(snapdragon);
  parsers(snapdragon);

  var ast = snapdragon.parse(pattern, options);
  ast.input = pattern;
  var res = snapdragon.compile(ast, options);
  res.input = pattern;
  return res;
};

/**
 * Expose `brackets` constructor, parsers and compilers
 */

brackets.compilers = compilers;
brackets.parsers = parsers;

/**
 * Expose `brackets`
 * @type {Function}
 */

module.exports = brackets;


/***/ }),

/***/ 2647:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var posix = __nccwpck_require__(4504);

module.exports = function(brackets) {
  brackets.compiler

    /**
     * Escaped characters
     */

    .set('escape', function(node) {
      return this.emit('\\' + node.val.replace(/^\\/, ''), node);
    })

    /**
     * Text
     */

    .set('text', function(node) {
      return this.emit(node.val.replace(/([{}])/g, '\\$1'), node);
    })

    /**
     * POSIX character classes
     */

    .set('posix', function(node) {
      if (node.val === '[::]') {
        return this.emit('\\[::\\]', node);
      }

      var val = posix[node.inner];
      if (typeof val === 'undefined') {
        val = '[' + node.inner + ']';
      }
      return this.emit(val, node);
    })

    /**
     * Non-posix brackets
     */

    .set('bracket', function(node) {
      return this.mapVisit(node.nodes);
    })
    .set('bracket.open', function(node) {
      return this.emit(node.val, node);
    })
    .set('bracket.inner', function(node) {
      var inner = node.val;

      if (inner === '[' || inner === ']') {
        return this.emit('\\' + node.val, node);
      }
      if (inner === '^]') {
        return this.emit('^\\]', node);
      }
      if (inner === '^') {
        return this.emit('^', node);
      }

      if (/-/.test(inner) && !/(\d-\d|\w-\w)/.test(inner)) {
        inner = inner.split('-').join('\\-');
      }

      var isNegated = inner.charAt(0) === '^';
      // add slashes to negated brackets, per spec
      if (isNegated && inner.indexOf('/') === -1) {
        inner += '/';
      }
      if (isNegated && inner.indexOf('.') === -1) {
        inner += '.';
      }

      // don't unescape `0` (octal literal)
      inner = inner.replace(/\\([1-9])/g, '$1');
      return this.emit(inner, node);
    })
    .set('bracket.close', function(node) {
      var val = node.val.replace(/^\\/, '');
      if (node.parent.escaped === true) {
        return this.emit('\\' + val, node);
      }
      return this.emit(val, node);
    });
};


/***/ }),

/***/ 8036:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var utils = __nccwpck_require__(8753);
var define = __nccwpck_require__(6967);

/**
 * Text regex
 */

var TEXT_REGEX = '(\\[(?=.*\\])|\\])+';
var not = utils.createRegex(TEXT_REGEX);

/**
 * Brackets parsers
 */

function parsers(brackets) {
  brackets.state = brackets.state || {};
  brackets.parser.sets.bracket = brackets.parser.sets.bracket || [];
  brackets.parser

    .capture('escape', function() {
      if (this.isInside('bracket')) return;
      var pos = this.position();
      var m = this.match(/^\\(.)/);
      if (!m) return;

      return pos({
        type: 'escape',
        val: m[0]
      });
    })

    /**
     * Text parser
     */

    .capture('text', function() {
      if (this.isInside('bracket')) return;
      var pos = this.position();
      var m = this.match(not);
      if (!m || !m[0]) return;

      return pos({
        type: 'text',
        val: m[0]
      });
    })

    /**
     * POSIX character classes: "[[:alpha:][:digits:]]"
     */

    .capture('posix', function() {
      var pos = this.position();
      var m = this.match(/^\[:(.*?):\](?=.*\])/);
      if (!m) return;

      var inside = this.isInside('bracket');
      if (inside) {
        brackets.posix++;
      }

      return pos({
        type: 'posix',
        insideBracket: inside,
        inner: m[1],
        val: m[0]
      });
    })

    /**
     * Bracket (noop)
     */

    .capture('bracket', function() {})

    /**
     * Open: '['
     */

    .capture('bracket.open', function() {
      var parsed = this.parsed;
      var pos = this.position();
      var m = this.match(/^\[(?=.*\])/);
      if (!m) return;

      var prev = this.prev();
      var last = utils.last(prev.nodes);

      if (parsed.slice(-1) === '\\' && !this.isInside('bracket')) {
        last.val = last.val.slice(0, last.val.length - 1);
        return pos({
          type: 'escape',
          val: m[0]
        });
      }

      var open = pos({
        type: 'bracket.open',
        val: m[0]
      });

      if (last.type === 'bracket.open' || this.isInside('bracket')) {
        open.val = '\\' + open.val;
        open.type = 'bracket.inner';
        open.escaped = true;
        return open;
      }

      var node = pos({
        type: 'bracket',
        nodes: [open]
      });

      define(node, 'parent', prev);
      define(open, 'parent', node);
      this.push('bracket', node);
      prev.nodes.push(node);
    })

    /**
     * Bracket text
     */

    .capture('bracket.inner', function() {
      if (!this.isInside('bracket')) return;
      var pos = this.position();
      var m = this.match(not);
      if (!m || !m[0]) return;

      var next = this.input.charAt(0);
      var val = m[0];

      var node = pos({
        type: 'bracket.inner',
        val: val
      });

      if (val === '\\\\') {
        return node;
      }

      var first = val.charAt(0);
      var last = val.slice(-1);

      if (first === '!') {
        val = '^' + val.slice(1);
      }

      if (last === '\\' || (val === '^' && next === ']')) {
        val += this.input[0];
        this.consume(1);
      }

      node.val = val;
      return node;
    })

    /**
     * Close: ']'
     */

    .capture('bracket.close', function() {
      var parsed = this.parsed;
      var pos = this.position();
      var m = this.match(/^\]/);
      if (!m) return;

      var prev = this.prev();
      var last = utils.last(prev.nodes);

      if (parsed.slice(-1) === '\\' && !this.isInside('bracket')) {
        last.val = last.val.slice(0, last.val.length - 1);

        return pos({
          type: 'escape',
          val: m[0]
        });
      }

      var node = pos({
        type: 'bracket.close',
        rest: this.input,
        val: m[0]
      });

      if (last.type === 'bracket.open') {
        node.type = 'bracket.inner';
        node.escaped = true;
        return node;
      }

      var bracket = this.pop('bracket');
      if (!this.isType(bracket, 'bracket')) {
        if (this.options.strict) {
          throw new Error('missing opening "["');
        }
        node.type = 'bracket.inner';
        node.escaped = true;
        return node;
      }

      bracket.nodes.push(node);
      define(node, 'parent', bracket);
    });
}

/**
 * Brackets parsers
 */

module.exports = parsers;

/**
 * Expose text regex
 */

module.exports.TEXT_REGEX = TEXT_REGEX;


/***/ }),

/***/ 8753:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {



var toRegex = __nccwpck_require__(6855);
var regexNot = __nccwpck_require__(2527);
var cached;

/**
 * Get the last element from `array`
 * @param {Array} `array`
 * @return {*}
 */

exports.last = function(arr) {
  return arr[arr.length - 1];
};

/**
 * Create and cache regex to use for text nodes
 */

exports.createRegex = function(pattern, include) {
  if (cached) return cached;
  var opts = {contains: true, strictClose: false};
  var not = regexNot.create(pattern, opts);
  var re;

  if (typeof include === 'string') {
    re = toRegex('^(?:' + include + '|' + not + ')', opts);
  } else {
    re = toRegex(not, opts);
  }

  return (cached = re);
};


/***/ }),

/***/ 7512:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var isObject = __nccwpck_require__(429);

module.exports = function extend(o/*, objects*/) {
  if (!isObject(o)) { o = {}; }

  var len = arguments.length;
  for (var i = 1; i < len; i++) {
    var obj = arguments[i];

    if (isObject(obj)) {
      assign(o, obj);
    }
  }
  return o;
};

function assign(a, b) {
  for (var key in b) {
    if (hasOwn(b, key)) {
      a[key] = b[key];
    }
  }
}

/**
 * Returns true if the given `key` is an own property of `obj`.
 */

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}


/***/ }),

/***/ 2129:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



/**
 * Module dependencies
 */

var extend = __nccwpck_require__(7512);
var unique = __nccwpck_require__(340);
var toRegex = __nccwpck_require__(6855);

/**
 * Local dependencies
 */

var compilers = __nccwpck_require__(5903);
var parsers = __nccwpck_require__(5138);
var Extglob = __nccwpck_require__(7020);
var utils = __nccwpck_require__(1327);
var MAX_LENGTH = 1024 * 64;

/**
 * Convert the given `extglob` pattern into a regex-compatible string. Returns
 * an object with the compiled result and the parsed AST.
 *
 * ```js
 * var extglob = require('extglob');
 * console.log(extglob('*.!(*a)'));
 * //=> '(?!\\.)[^/]*?\\.(?!(?!\\.)[^/]*?a\\b).*?'
 * ```
 * @param {String} `pattern`
 * @param {Object} `options`
 * @return {String}
 * @api public
 */

function extglob(pattern, options) {
  return extglob.create(pattern, options).output;
}

/**
 * Takes an array of strings and an extglob pattern and returns a new
 * array that contains only the strings that match the pattern.
 *
 * ```js
 * var extglob = require('extglob');
 * console.log(extglob.match(['a.a', 'a.b', 'a.c'], '*.!(*a)'));
 * //=> ['a.b', 'a.c']
 * ```
 * @param {Array} `list` Array of strings to match
 * @param {String} `pattern` Extglob pattern
 * @param {Object} `options`
 * @return {Array} Returns an array of matches
 * @api public
 */

extglob.match = function(list, pattern, options) {
  if (typeof pattern !== 'string') {
    throw new TypeError('expected pattern to be a string');
  }

  list = utils.arrayify(list);
  var isMatch = extglob.matcher(pattern, options);
  var len = list.length;
  var idx = -1;
  var matches = [];

  while (++idx < len) {
    var ele = list[idx];

    if (isMatch(ele)) {
      matches.push(ele);
    }
  }

  // if no options were passed, uniquify results and return
  if (typeof options === 'undefined') {
    return unique(matches);
  }

  if (matches.length === 0) {
    if (options.failglob === true) {
      throw new Error('no matches found for "' + pattern + '"');
    }
    if (options.nonull === true || options.nullglob === true) {
      return [pattern.split('\\').join('')];
    }
  }

  return options.nodupes !== false ? unique(matches) : matches;
};

/**
 * Returns true if the specified `string` matches the given
 * extglob `pattern`.
 *
 * ```js
 * var extglob = require('extglob');
 *
 * console.log(extglob.isMatch('a.a', '*.!(*a)'));
 * //=> false
 * console.log(extglob.isMatch('a.b', '*.!(*a)'));
 * //=> true
 * ```
 * @param {String} `string` String to match
 * @param {String} `pattern` Extglob pattern
 * @param {String} `options`
 * @return {Boolean}
 * @api public
 */

extglob.isMatch = function(str, pattern, options) {
  if (typeof pattern !== 'string') {
    throw new TypeError('expected pattern to be a string');
  }

  if (typeof str !== 'string') {
    throw new TypeError('expected a string');
  }

  if (pattern === str) {
    return true;
  }

  if (pattern === '' || pattern === ' ' || pattern === '.') {
    return pattern === str;
  }

  var isMatch = utils.memoize('isMatch', pattern, options, extglob.matcher);
  return isMatch(str);
};

/**
 * Returns true if the given `string` contains the given pattern. Similar to `.isMatch` but
 * the pattern can match any part of the string.
 *
 * ```js
 * var extglob = require('extglob');
 * console.log(extglob.contains('aa/bb/cc', '*b'));
 * //=> true
 * console.log(extglob.contains('aa/bb/cc', '*d'));
 * //=> false
 * ```
 * @param {String} `str` The string to match.
 * @param {String} `pattern` Glob pattern to use for matching.
 * @param {Object} `options`
 * @return {Boolean} Returns true if the patter matches any part of `str`.
 * @api public
 */

extglob.contains = function(str, pattern, options) {
  if (typeof str !== 'string') {
    throw new TypeError('expected a string');
  }

  if (pattern === '' || pattern === ' ' || pattern === '.') {
    return pattern === str;
  }

  var opts = extend({}, options, {contains: true});
  opts.strictClose = false;
  opts.strictOpen = false;
  return extglob.isMatch(str, pattern, opts);
};

/**
 * Takes an extglob pattern and returns a matcher function. The returned
 * function takes the string to match as its only argument.
 *
 * ```js
 * var extglob = require('extglob');
 * var isMatch = extglob.matcher('*.!(*a)');
 *
 * console.log(isMatch('a.a'));
 * //=> false
 * console.log(isMatch('a.b'));
 * //=> true
 * ```
 * @param {String} `pattern` Extglob pattern
 * @param {String} `options`
 * @return {Boolean}
 * @api public
 */

extglob.matcher = function(pattern, options) {
  if (typeof pattern !== 'string') {
    throw new TypeError('expected pattern to be a string');
  }

  function matcher() {
    var re = extglob.makeRe(pattern, options);
    return function(str) {
      return re.test(str);
    };
  }

  return utils.memoize('matcher', pattern, options, matcher);
};

/**
 * Convert the given `extglob` pattern into a regex-compatible string. Returns
 * an object with the compiled result and the parsed AST.
 *
 * ```js
 * var extglob = require('extglob');
 * console.log(extglob.create('*.!(*a)').output);
 * //=> '(?!\\.)[^/]*?\\.(?!(?!\\.)[^/]*?a\\b).*?'
 * ```
 * @param {String} `str`
 * @param {Object} `options`
 * @return {String}
 * @api public
 */

extglob.create = function(pattern, options) {
  if (typeof pattern !== 'string') {
    throw new TypeError('expected pattern to be a string');
  }

  function create() {
    var ext = new Extglob(options);
    var ast = ext.parse(pattern, options);
    return ext.compile(ast, options);
  }

  return utils.memoize('create', pattern, options, create);
};

/**
 * Returns an array of matches captured by `pattern` in `string`, or `null`
 * if the pattern did not match.
 *
 * ```js
 * var extglob = require('extglob');
 * extglob.capture(pattern, string[, options]);
 *
 * console.log(extglob.capture('test/*.js', 'test/foo.js'));
 * //=> ['foo']
 * console.log(extglob.capture('test/*.js', 'foo/bar.css'));
 * //=> null
 * ```
 * @param {String} `pattern` Glob pattern to use for matching.
 * @param {String} `string` String to match
 * @param {Object} `options` See available [options](#options) for changing how matches are performed
 * @return {Boolean} Returns an array of captures if the string matches the glob pattern, otherwise `null`.
 * @api public
 */

extglob.capture = function(pattern, str, options) {
  var re = extglob.makeRe(pattern, extend({capture: true}, options));

  function match() {
    return function(string) {
      var match = re.exec(string);
      if (!match) {
        return null;
      }

      return match.slice(1);
    };
  }

  var capture = utils.memoize('capture', pattern, options, match);
  return capture(str);
};

/**
 * Create a regular expression from the given `pattern` and `options`.
 *
 * ```js
 * var extglob = require('extglob');
 * var re = extglob.makeRe('*.!(*a)');
 * console.log(re);
 * //=> /^[^\/]*?\.(?![^\/]*?a)[^\/]*?$/
 * ```
 * @param {String} `pattern` The pattern to convert to regex.
 * @param {Object} `options`
 * @return {RegExp}
 * @api public
 */

extglob.makeRe = function(pattern, options) {
  if (pattern instanceof RegExp) {
    return pattern;
  }

  if (typeof pattern !== 'string') {
    throw new TypeError('expected pattern to be a string');
  }

  if (pattern.length > MAX_LENGTH) {
    throw new Error('expected pattern to be less than ' + MAX_LENGTH + ' characters');
  }

  function makeRe() {
    var opts = extend({strictErrors: false}, options);
    if (opts.strictErrors === true) opts.strict = true;
    var res = extglob.create(pattern, opts);
    return toRegex(res.output, opts);
  }

  var regex = utils.memoize('makeRe', pattern, options, makeRe);
  if (regex.source.length > MAX_LENGTH) {
    throw new SyntaxError('potentially malicious regex detected');
  }

  return regex;
};

/**
 * Cache
 */

extglob.cache = utils.cache;
extglob.clearCache = function() {
  extglob.cache.__data__ = {};
};

/**
 * Expose `Extglob` constructor, parsers and compilers
 */

extglob.Extglob = Extglob;
extglob.compilers = compilers;
extglob.parsers = parsers;

/**
 * Expose `extglob`
 * @type {Function}
 */

module.exports = extglob;


/***/ }),

/***/ 5903:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var brackets = __nccwpck_require__(5809);

/**
 * Extglob compilers
 */

module.exports = function(extglob) {
  function star() {
    if (typeof extglob.options.star === 'function') {
      return extglob.options.star.apply(this, arguments);
    }
    if (typeof extglob.options.star === 'string') {
      return extglob.options.star;
    }
    return '.*?';
  }

  /**
   * Use `expand-brackets` compilers
   */

  extglob.use(brackets.compilers);
  extglob.compiler

    /**
     * Escaped: "\\*"
     */

    .set('escape', function(node) {
      return this.emit(node.val, node);
    })

    /**
     * Dot: "."
     */

    .set('dot', function(node) {
      return this.emit('\\' + node.val, node);
    })

    /**
     * Question mark: "?"
     */

    .set('qmark', function(node) {
      var val = '[^\\\\/.]';
      var prev = this.prev();

      if (node.parsed.slice(-1) === '(') {
        var ch = node.rest.charAt(0);
        if (ch !== '!' && ch !== '=' && ch !== ':') {
          return this.emit(val, node);
        }
        return this.emit(node.val, node);
      }

      if (prev.type === 'text' && prev.val) {
        return this.emit(val, node);
      }

      if (node.val.length > 1) {
        val += '{' + node.val.length + '}';
      }
      return this.emit(val, node);
    })

    /**
     * Plus: "+"
     */

    .set('plus', function(node) {
      var prev = node.parsed.slice(-1);
      if (prev === ']' || prev === ')') {
        return this.emit(node.val, node);
      }
      var ch = this.output.slice(-1);
      if (!this.output || (/[?*+]/.test(ch) && node.parent.type !== 'bracket')) {
        return this.emit('\\+', node);
      }
      if (/\w/.test(ch) && !node.inside) {
        return this.emit('+\\+?', node);
      }
      return this.emit('+', node);
    })

    /**
     * Star: "*"
     */

    .set('star', function(node) {
      var prev = this.prev();
      var prefix = prev.type !== 'text' && prev.type !== 'escape'
        ? '(?!\\.)'
        : '';

      return this.emit(prefix + star.call(this, node), node);
    })

    /**
     * Parens
     */

    .set('paren', function(node) {
      return this.mapVisit(node.nodes);
    })
    .set('paren.open', function(node) {
      var capture = this.options.capture ? '(' : '';

      switch (node.parent.prefix) {
        case '!':
        case '^':
          return this.emit(capture + '(?:(?!(?:', node);
        case '*':
        case '+':
        case '?':
        case '@':
          return this.emit(capture + '(?:', node);
        default: {
          var val = node.val;
          if (this.options.bash === true) {
            val = '\\' + val;
          } else if (!this.options.capture && val === '(' && node.parent.rest[0] !== '?') {
            val += '?:';
          }

          return this.emit(val, node);
        }
      }
    })
    .set('paren.close', function(node) {
      var capture = this.options.capture ? ')' : '';

      switch (node.prefix) {
        case '!':
        case '^':
          var prefix = /^(\)|$)/.test(node.rest) ? '$' : '';
          var str = star.call(this, node);

          // if the extglob has a slash explicitly defined, we know the user wants
          // to match slashes, so we need to ensure the "star" regex allows for it
          if (node.parent.hasSlash && !this.options.star && this.options.slash !== false) {
            str = '.*?';
          }

          return this.emit(prefix + ('))' + str + ')') + capture, node);
        case '*':
        case '+':
        case '?':
          return this.emit(')' + node.prefix + capture, node);
        case '@':
          return this.emit(')' + capture, node);
        default: {
          var val = (this.options.bash === true ? '\\' : '') + ')';
          return this.emit(val, node);
        }
      }
    })

    /**
     * Text
     */

    .set('text', function(node) {
      var val = node.val.replace(/[\[\]]/g, '\\$&');
      return this.emit(val, node);
    });
};


/***/ }),

/***/ 7020:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



/**
 * Module dependencies
 */

var Snapdragon = __nccwpck_require__(2403);
var define = __nccwpck_require__(7898);
var extend = __nccwpck_require__(7512);

/**
 * Local dependencies
 */

var compilers = __nccwpck_require__(5903);
var parsers = __nccwpck_require__(5138);

/**
 * Customize Snapdragon parser and renderer
 */

function Extglob(options) {
  this.options = extend({source: 'extglob'}, options);
  this.snapdragon = this.options.snapdragon || new Snapdragon(this.options);
  this.snapdragon.patterns = this.snapdragon.patterns || {};
  this.compiler = this.snapdragon.compiler;
  this.parser = this.snapdragon.parser;

  compilers(this.snapdragon);
  parsers(this.snapdragon);

  /**
   * Override Snapdragon `.parse` method
   */

  define(this.snapdragon, 'parse', function(str, options) {
    var parsed = Snapdragon.prototype.parse.apply(this, arguments);
    parsed.input = str;

    // escape unmatched brace/bracket/parens
    var last = this.parser.stack.pop();
    if (last && this.options.strict !== true) {
      var node = last.nodes[0];
      node.val = '\\' + node.val;
      var sibling = node.parent.nodes[1];
      if (sibling.type === 'star') {
        sibling.loose = true;
      }
    }

    // add non-enumerable parser reference
    define(parsed, 'parser', this.parser);
    return parsed;
  });

  /**
   * Decorate `.parse` method
   */

  define(this, 'parse', function(ast, options) {
    return this.snapdragon.parse.apply(this.snapdragon, arguments);
  });

  /**
   * Decorate `.compile` method
   */

  define(this, 'compile', function(ast, options) {
    return this.snapdragon.compile.apply(this.snapdragon, arguments);
  });

}

/**
 * Expose `Extglob`
 */

module.exports = Extglob;


/***/ }),

/***/ 5138:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var brackets = __nccwpck_require__(5809);
var define = __nccwpck_require__(7898);
var utils = __nccwpck_require__(1327);

/**
 * Characters to use in text regex (we want to "not" match
 * characters that are matched by other parsers)
 */

var TEXT_REGEX = '([!@*?+]?\\(|\\)|[*?.+\\\\]|\\[:?(?=.*\\])|:?\\])+';
var not = utils.createRegex(TEXT_REGEX);

/**
 * Extglob parsers
 */

function parsers(extglob) {
  extglob.state = extglob.state || {};

  /**
   * Use `expand-brackets` parsers
   */

  extglob.use(brackets.parsers);
  extglob.parser.sets.paren = extglob.parser.sets.paren || [];
  extglob.parser

    /**
     * Extglob open: "*("
     */

    .capture('paren.open', function() {
      var parsed = this.parsed;
      var pos = this.position();
      var m = this.match(/^([!@*?+])?\(/);
      if (!m) return;

      var prev = this.prev();
      var prefix = m[1];
      var val = m[0];

      var open = pos({
        type: 'paren.open',
        parsed: parsed,
        val: val
      });

      var node = pos({
        type: 'paren',
        prefix: prefix,
        nodes: [open]
      });

      // if nested negation extglobs, just cancel them out to simplify
      if (prefix === '!' && prev.type === 'paren' && prev.prefix === '!') {
        prev.prefix = '@';
        node.prefix = '@';
      }

      define(node, 'rest', this.input);
      define(node, 'parsed', parsed);
      define(node, 'parent', prev);
      define(open, 'parent', node);

      this.push('paren', node);
      prev.nodes.push(node);
    })

    /**
     * Extglob close: ")"
     */

    .capture('paren.close', function() {
      var parsed = this.parsed;
      var pos = this.position();
      var m = this.match(/^\)/);
      if (!m) return;

      var parent = this.pop('paren');
      var node = pos({
        type: 'paren.close',
        rest: this.input,
        parsed: parsed,
        val: m[0]
      });

      if (!this.isType(parent, 'paren')) {
        if (this.options.strict) {
          throw new Error('missing opening paren: "("');
        }
        node.escaped = true;
        return node;
      }

      node.prefix = parent.prefix;
      parent.nodes.push(node);
      define(node, 'parent', parent);
    })

    /**
     * Escape: "\\."
     */

    .capture('escape', function() {
      var pos = this.position();
      var m = this.match(/^\\(.)/);
      if (!m) return;

      return pos({
        type: 'escape',
        val: m[0],
        ch: m[1]
      });
    })

    /**
     * Question marks: "?"
     */

    .capture('qmark', function() {
      var parsed = this.parsed;
      var pos = this.position();
      var m = this.match(/^\?+(?!\()/);
      if (!m) return;
      extglob.state.metachar = true;
      return pos({
        type: 'qmark',
        rest: this.input,
        parsed: parsed,
        val: m[0]
      });
    })

    /**
     * Character parsers
     */

    .capture('star', /^\*(?!\()/)
    .capture('plus', /^\+(?!\()/)
    .capture('dot', /^\./)
    .capture('text', not);
};

/**
 * Expose text regex string
 */

module.exports.TEXT_REGEX = TEXT_REGEX;

/**
 * Extglob parsers
 */

module.exports = parsers;


/***/ }),

/***/ 1327:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var regex = __nccwpck_require__(2527);
var Cache = __nccwpck_require__(4838);

/**
 * Utils
 */

var utils = module.exports;
var cache = utils.cache = new Cache();

/**
 * Cast `val` to an array
 * @return {Array}
 */

utils.arrayify = function(val) {
  if (!Array.isArray(val)) {
    return [val];
  }
  return val;
};

/**
 * Memoize a generated regex or function
 */

utils.memoize = function(type, pattern, options, fn) {
  var key = utils.createKey(type + pattern, options);

  if (cache.has(type, key)) {
    return cache.get(type, key);
  }

  var val = fn(pattern, options);
  if (options && options.cache === false) {
    return val;
  }

  cache.set(type, key, val);
  return val;
};

/**
 * Create the key to use for memoization. The key is generated
 * by iterating over the options and concatenating key-value pairs
 * to the pattern string.
 */

utils.createKey = function(pattern, options) {
  var key = pattern;
  if (typeof options === 'undefined') {
    return key;
  }
  for (var prop in options) {
    key += ';' + prop + '=' + String(options[prop]);
  }
  return key;
};

/**
 * Create the regex to use for matching text
 */

utils.createRegex = function(str) {
  var opts = {contains: true, strictClose: false};
  return regex(str, opts);
};


/***/ }),

/***/ 7898:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * define-property <https://github.com/jonschlinkert/define-property>
 *
 * Copyright (c) 2015, 2017, Jon Schlinkert.
 * Released under the MIT License.
 */



var isDescriptor = __nccwpck_require__(567);

module.exports = function defineProperty(obj, prop, val) {
  if (typeof obj !== 'object' && typeof obj !== 'function') {
    throw new TypeError('expected an object or function.');
  }

  if (typeof prop !== 'string') {
    throw new TypeError('expected `prop` to be a string.');
  }

  if (isDescriptor(val) && ('set' in val || 'get' in val)) {
    return Object.defineProperty(obj, prop, val);
  }

  return Object.defineProperty(obj, prop, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: val
  });
};


/***/ }),

/***/ 2147:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

const pkg = __nccwpck_require__(3664);

module.exports = pkg.async;
module.exports["default"] = pkg.async;

module.exports.async = pkg.async;
module.exports.sync = pkg.sync;
module.exports.stream = pkg.stream;

module.exports.generateTasks = pkg.generateTasks;


/***/ }),

/***/ 4027:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * is-glob <https://github.com/jonschlinkert/is-glob>
 *
 * Copyright (c) 2014-2017, Jon Schlinkert.
 * Released under the MIT License.
 */

var isExtglob = __nccwpck_require__(6435);
var chars = { '{': '}', '(': ')', '[': ']'};
var strictCheck = function(str) {
  if (str[0] === '!') {
    return true;
  }
  var index = 0;
  var pipeIndex = -2;
  var closeSquareIndex = -2;
  var closeCurlyIndex = -2;
  var closeParenIndex = -2;
  var backSlashIndex = -2;
  while (index < str.length) {
    if (str[index] === '*') {
      return true;
    }

    if (str[index + 1] === '?' && /[\].+)]/.test(str[index])) {
      return true;
    }

    if (closeSquareIndex !== -1 && str[index] === '[' && str[index + 1] !== ']') {
      if (closeSquareIndex < index) {
        closeSquareIndex = str.indexOf(']', index);
      }
      if (closeSquareIndex > index) {
        if (backSlashIndex === -1 || backSlashIndex > closeSquareIndex) {
          return true;
        }
        backSlashIndex = str.indexOf('\\', index);
        if (backSlashIndex === -1 || backSlashIndex > closeSquareIndex) {
          return true;
        }
      }
    }

    if (closeCurlyIndex !== -1 && str[index] === '{' && str[index + 1] !== '}') {
      closeCurlyIndex = str.indexOf('}', index);
      if (closeCurlyIndex > index) {
        backSlashIndex = str.indexOf('\\', index);
        if (backSlashIndex === -1 || backSlashIndex > closeCurlyIndex) {
          return true;
        }
      }
    }

    if (closeParenIndex !== -1 && str[index] === '(' && str[index + 1] === '?' && /[:!=]/.test(str[index + 2]) && str[index + 3] !== ')') {
      closeParenIndex = str.indexOf(')', index);
      if (closeParenIndex > index) {
        backSlashIndex = str.indexOf('\\', index);
        if (backSlashIndex === -1 || backSlashIndex > closeParenIndex) {
          return true;
        }
      }
    }

    if (pipeIndex !== -1 && str[index] === '(' && str[index + 1] !== '|') {
      if (pipeIndex < index) {
        pipeIndex = str.indexOf('|', index);
      }
      if (pipeIndex !== -1 && str[pipeIndex + 1] !== ')') {
        closeParenIndex = str.indexOf(')', pipeIndex);
        if (closeParenIndex > pipeIndex) {
          backSlashIndex = str.indexOf('\\', pipeIndex);
          if (backSlashIndex === -1 || backSlashIndex > closeParenIndex) {
            return true;
          }
        }
      }
    }

    if (str[index] === '\\') {
      var open = str[index + 1];
      index += 2;
      var close = chars[open];

      if (close) {
        var n = str.indexOf(close, index);
        if (n !== -1) {
          index = n + 1;
        }
      }

      if (str[index] === '!') {
        return true;
      }
    } else {
      index++;
    }
  }
  return false;
};

var relaxedCheck = function(str) {
  if (str[0] === '!') {
    return true;
  }
  var index = 0;
  while (index < str.length) {
    if (/[*?{}()[\]]/.test(str[index])) {
      return true;
    }

    if (str[index] === '\\') {
      var open = str[index + 1];
      index += 2;
      var close = chars[open];

      if (close) {
        var n = str.indexOf(close, index);
        if (n !== -1) {
          index = n + 1;
        }
      }

      if (str[index] === '!') {
        return true;
      }
    } else {
      index++;
    }
  }
  return false;
};

module.exports = function isGlob(str, options) {
  if (typeof str !== 'string' || str === '') {
    return false;
  }

  if (isExtglob(str)) {
    return true;
  }

  var check = strictCheck;

  // optionally relax check
  if (options && options.strict === false) {
    check = relaxedCheck;
  }

  return check(str);
};


/***/ }),

/***/ 4734:
/***/ (function(__unused_webpack_module, exports, __nccwpck_require__) {


var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
var stream = __nccwpck_require__(2781);
var fsStat = __nccwpck_require__(109);
var fs_1 = __nccwpck_require__(6746);
var FileSystemStream = /** @class */ (function (_super) {
    __extends(FileSystemStream, _super);
    function FileSystemStream() {
        return _super !== null && _super.apply(this, arguments) || this;
    }
    /**
     * Use stream API to read entries for Task.
     */
    FileSystemStream.prototype.read = function (patterns, filter) {
        var _this = this;
        var filepaths = patterns.map(this.getFullEntryPath, this);
        var transform = new stream.Transform({ objectMode: true });
        transform._transform = function (index, _enc, done) {
            return _this.getEntry(filepaths[index], patterns[index]).then(function (entry) {
                if (entry !== null && filter(entry)) {
                    transform.push(entry);
                }
                if (index === filepaths.length - 1) {
                    transform.end();
                }
                done();
            });
        };
        for (var i = 0; i < filepaths.length; i++) {
            transform.write(i);
        }
        return transform;
    };
    /**
     * Return entry for the provided path.
     */
    FileSystemStream.prototype.getEntry = function (filepath, pattern) {
        var _this = this;
        return this.getStat(filepath)
            .then(function (stat) { return _this.makeEntry(stat, pattern); })
            .catch(function () { return null; });
    };
    /**
     * Return fs.Stats for the provided path.
     */
    FileSystemStream.prototype.getStat = function (filepath) {
        return fsStat.stat(filepath, { throwErrorOnBrokenSymlinks: false });
    };
    return FileSystemStream;
}(fs_1.default));
exports["default"] = FileSystemStream;


/***/ }),

/***/ 6427:
/***/ (function(__unused_webpack_module, exports, __nccwpck_require__) {


var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
var fsStat = __nccwpck_require__(109);
var fs_1 = __nccwpck_require__(6746);
var FileSystemSync = /** @class */ (function (_super) {
    __extends(FileSystemSync, _super);
    function FileSystemSync() {
        return _super !== null && _super.apply(this, arguments) || this;
    }
    /**
     * Use sync API to read entries for Task.
     */
    FileSystemSync.prototype.read = function (patterns, filter) {
        var _this = this;
        var entries = [];
        patterns.forEach(function (pattern) {
            var filepath = _this.getFullEntryPath(pattern);
            var entry = _this.getEntry(filepath, pattern);
            if (entry === null || !filter(entry)) {
                return;
            }
            entries.push(entry);
        });
        return entries;
    };
    /**
     * Return entry for the provided path.
     */
    FileSystemSync.prototype.getEntry = function (filepath, pattern) {
        try {
            var stat = this.getStat(filepath);
            return this.makeEntry(stat, pattern);
        }
        catch (err) {
            return null;
        }
    };
    /**
     * Return fs.Stats for the provided path.
     */
    FileSystemSync.prototype.getStat = function (filepath) {
        return fsStat.statSync(filepath, { throwErrorOnBrokenSymlinks: false });
    };
    return FileSystemSync;
}(fs_1.default));
exports["default"] = FileSystemSync;


/***/ }),

/***/ 6746:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
var path = __nccwpck_require__(1017);
var FileSystem = /** @class */ (function () {
    function FileSystem(options) {
        this.options = options;
    }
    /**
     * Return full path to entry.
     */
    FileSystem.prototype.getFullEntryPath = function (filepath) {
        return path.resolve(this.options.cwd, filepath);
    };
    /**
     * Return an implementation of the Entry interface.
     */
    FileSystem.prototype.makeEntry = function (stat, pattern) {
        stat.path = pattern;
        stat.depth = pattern.split('/').length;
        return stat;
    };
    return FileSystem;
}());
exports["default"] = FileSystem;


/***/ }),

/***/ 3664:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
var optionsManager = __nccwpck_require__(5337);
var taskManager = __nccwpck_require__(2708);
var reader_async_1 = __nccwpck_require__(1803);
var reader_stream_1 = __nccwpck_require__(2830);
var reader_sync_1 = __nccwpck_require__(647);
var arrayUtils = __nccwpck_require__(5325);
var streamUtils = __nccwpck_require__(8382);
/**
 * Synchronous API.
 */
function sync(source, opts) {
    assertPatternsInput(source);
    var works = getWorks(source, reader_sync_1.default, opts);
    return arrayUtils.flatten(works);
}
exports.sync = sync;
/**
 * Asynchronous API.
 */
function async(source, opts) {
    try {
        assertPatternsInput(source);
    }
    catch (error) {
        return Promise.reject(error);
    }
    var works = getWorks(source, reader_async_1.default, opts);
    return Promise.all(works).then(arrayUtils.flatten);
}
exports.async = async;
/**
 * Stream API.
 */
function stream(source, opts) {
    assertPatternsInput(source);
    var works = getWorks(source, reader_stream_1.default, opts);
    return streamUtils.merge(works);
}
exports.stream = stream;
/**
 * Return a set of tasks based on provided patterns.
 */
function generateTasks(source, opts) {
    assertPatternsInput(source);
    var patterns = [].concat(source);
    var options = optionsManager.prepare(opts);
    return taskManager.generate(patterns, options);
}
exports.generateTasks = generateTasks;
/**
 * Returns a set of works based on provided tasks and class of the reader.
 */
function getWorks(source, _Reader, opts) {
    var patterns = [].concat(source);
    var options = optionsManager.prepare(opts);
    var tasks = taskManager.generate(patterns, options);
    var reader = new _Reader(options);
    return tasks.map(reader.read, reader);
}
function assertPatternsInput(source) {
    if ([].concat(source).every(isString)) {
        return;
    }
    throw new TypeError('Patterns must be a string or an array of strings');
}
function isString(source) {
    /* tslint:disable-next-line strict-type-predicates */
    return typeof source === 'string';
}


/***/ }),

/***/ 5337:
/***/ (function(__unused_webpack_module, exports) {


var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
function prepare(options) {
    var opts = __assign({ cwd: process.cwd(), deep: true, ignore: [], dot: false, stats: false, onlyFiles: true, onlyDirectories: false, followSymlinkedDirectories: true, unique: true, markDirectories: false, absolute: false, nobrace: false, brace: true, noglobstar: false, globstar: true, noext: false, extension: true, nocase: false, case: true, matchBase: false, transform: null }, options);
    if (opts.onlyDirectories) {
        opts.onlyFiles = false;
    }
    opts.brace = !opts.nobrace;
    opts.globstar = !opts.noglobstar;
    opts.extension = !opts.noext;
    opts.case = !opts.nocase;
    if (options) {
        opts.brace = ('brace' in options ? options.brace : opts.brace);
        opts.globstar = ('globstar' in options ? options.globstar : opts.globstar);
        opts.extension = ('extension' in options ? options.extension : opts.extension);
        opts.case = ('case' in options ? options.case : opts.case);
    }
    return opts;
}
exports.prepare = prepare;


/***/ }),

/***/ 2708:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
var patternUtils = __nccwpck_require__(1221);
/**
 * Generate tasks based on parent directory of each pattern.
 */
function generate(patterns, options) {
    var unixPatterns = patterns.map(patternUtils.unixifyPattern);
    var unixIgnore = options.ignore.map(patternUtils.unixifyPattern);
    var positivePatterns = getPositivePatterns(unixPatterns);
    var negativePatterns = getNegativePatternsAsPositive(unixPatterns, unixIgnore);
    /**
     * When the `case` option is disabled, all patterns must be marked as dynamic, because we cannot check filepath
     * directly (without read directory).
     */
    var staticPatterns = !options.case ? [] : positivePatterns.filter(patternUtils.isStaticPattern);
    var dynamicPatterns = !options.case ? positivePatterns : positivePatterns.filter(patternUtils.isDynamicPattern);
    var staticTasks = convertPatternsToTasks(staticPatterns, negativePatterns, /* dynamic */ false);
    var dynamicTasks = convertPatternsToTasks(dynamicPatterns, negativePatterns, /* dynamic */ true);
    return staticTasks.concat(dynamicTasks);
}
exports.generate = generate;
/**
 * Convert patterns to tasks based on parent directory of each pattern.
 */
function convertPatternsToTasks(positive, negative, dynamic) {
    var positivePatternsGroup = groupPatternsByBaseDirectory(positive);
    // When we have a global group – there is no reason to divide the patterns into independent tasks.
    // In this case, the global task covers the rest.
    if ('.' in positivePatternsGroup) {
        var task = convertPatternGroupToTask('.', positive, negative, dynamic);
        return [task];
    }
    return convertPatternGroupsToTasks(positivePatternsGroup, negative, dynamic);
}
exports.convertPatternsToTasks = convertPatternsToTasks;
/**
 * Return only positive patterns.
 */
function getPositivePatterns(patterns) {
    return patternUtils.getPositivePatterns(patterns);
}
exports.getPositivePatterns = getPositivePatterns;
/**
 * Return only negative patterns.
 */
function getNegativePatternsAsPositive(patterns, ignore) {
    var negative = patternUtils.getNegativePatterns(patterns).concat(ignore);
    var positive = negative.map(patternUtils.convertToPositivePattern);
    return positive;
}
exports.getNegativePatternsAsPositive = getNegativePatternsAsPositive;
/**
 * Group patterns by base directory of each pattern.
 */
function groupPatternsByBaseDirectory(patterns) {
    return patterns.reduce(function (collection, pattern) {
        var base = patternUtils.getBaseDirectory(pattern);
        if (base in collection) {
            collection[base].push(pattern);
        }
        else {
            collection[base] = [pattern];
        }
        return collection;
    }, {});
}
exports.groupPatternsByBaseDirectory = groupPatternsByBaseDirectory;
/**
 * Convert group of patterns to tasks.
 */
function convertPatternGroupsToTasks(positive, negative, dynamic) {
    return Object.keys(positive).map(function (base) {
        return convertPatternGroupToTask(base, positive[base], negative, dynamic);
    });
}
exports.convertPatternGroupsToTasks = convertPatternGroupsToTasks;
/**
 * Create a task for positive and negative patterns.
 */
function convertPatternGroupToTask(base, positive, negative, dynamic) {
    return {
        base: base,
        dynamic: dynamic,
        positive: positive,
        negative: negative,
        patterns: [].concat(positive, negative.map(patternUtils.convertToNegativePattern))
    };
}
exports.convertPatternGroupToTask = convertPatternGroupToTask;


/***/ }),

/***/ 6983:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
var pathUtils = __nccwpck_require__(3873);
var patternUtils = __nccwpck_require__(1221);
var DeepFilter = /** @class */ (function () {
    function DeepFilter(options, micromatchOptions) {
        this.options = options;
        this.micromatchOptions = micromatchOptions;
    }
    /**
     * Returns filter for directories.
     */
    DeepFilter.prototype.getFilter = function (positive, negative) {
        var _this = this;
        var maxPatternDepth = this.getMaxPatternDepth(positive);
        var negativeRe = this.getNegativePatternsRe(negative);
        return function (entry) { return _this.filter(entry, negativeRe, maxPatternDepth); };
    };
    /**
     * Returns max depth of the provided patterns.
     */
    DeepFilter.prototype.getMaxPatternDepth = function (patterns) {
        var globstar = patterns.some(patternUtils.hasGlobStar);
        return globstar ? Infinity : patternUtils.getMaxNaivePatternsDepth(patterns);
    };
    /**
     * Returns RegExp's for patterns that can affect the depth of reading.
     */
    DeepFilter.prototype.getNegativePatternsRe = function (patterns) {
        var affectDepthOfReadingPatterns = patterns.filter(patternUtils.isAffectDepthOfReadingPattern);
        return patternUtils.convertPatternsToRe(affectDepthOfReadingPatterns, this.micromatchOptions);
    };
    /**
     * Returns «true» for directory that should be read.
     */
    DeepFilter.prototype.filter = function (entry, negativeRe, maxPatternDepth) {
        if (this.isSkippedByDeepOption(entry.depth)) {
            return false;
        }
        if (this.isSkippedByMaxPatternDepth(entry.depth, maxPatternDepth)) {
            return false;
        }
        if (this.isSkippedSymlinkedDirectory(entry)) {
            return false;
        }
        if (this.isSkippedDotDirectory(entry)) {
            return false;
        }
        return this.isSkippedByNegativePatterns(entry, negativeRe);
    };
    /**
     * Returns «true» when the «deep» option is disabled or number and depth of the entry is greater that the option value.
     */
    DeepFilter.prototype.isSkippedByDeepOption = function (entryDepth) {
        return !this.options.deep || (typeof this.options.deep === 'number' && entryDepth >= this.options.deep);
    };
    /**
     * Returns «true» when depth parameter is not an Infinity and entry depth greater that the parameter value.
     */
    DeepFilter.prototype.isSkippedByMaxPatternDepth = function (entryDepth, maxPatternDepth) {
        return maxPatternDepth !== Infinity && entryDepth >= maxPatternDepth;
    };
    /**
     * Returns «true» for symlinked directory if the «followSymlinkedDirectories» option is disabled.
     */
    DeepFilter.prototype.isSkippedSymlinkedDirectory = function (entry) {
        return !this.options.followSymlinkedDirectories && entry.isSymbolicLink();
    };
    /**
     * Returns «true» for a directory whose name starts with a period if «dot» option is disabled.
     */
    DeepFilter.prototype.isSkippedDotDirectory = function (entry) {
        return !this.options.dot && pathUtils.isDotDirectory(entry.path);
    };
    /**
     * Returns «true» for a directory whose path math to any negative pattern.
     */
    DeepFilter.prototype.isSkippedByNegativePatterns = function (entry, negativeRe) {
        return !patternUtils.matchAny(entry.path, negativeRe);
    };
    return DeepFilter;
}());
exports["default"] = DeepFilter;


/***/ }),

/***/ 1343:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
var pathUtils = __nccwpck_require__(3873);
var patternUtils = __nccwpck_require__(1221);
var EntryFilter = /** @class */ (function () {
    function EntryFilter(options, micromatchOptions) {
        this.options = options;
        this.micromatchOptions = micromatchOptions;
        this.index = new Map();
    }
    /**
     * Returns filter for directories.
     */
    EntryFilter.prototype.getFilter = function (positive, negative) {
        var _this = this;
        var positiveRe = patternUtils.convertPatternsToRe(positive, this.micromatchOptions);
        var negativeRe = patternUtils.convertPatternsToRe(negative, this.micromatchOptions);
        return function (entry) { return _this.filter(entry, positiveRe, negativeRe); };
    };
    /**
     * Returns true if entry must be added to result.
     */
    EntryFilter.prototype.filter = function (entry, positiveRe, negativeRe) {
        // Exclude duplicate results
        if (this.options.unique) {
            if (this.isDuplicateEntry(entry)) {
                return false;
            }
            this.createIndexRecord(entry);
        }
        // Filter files and directories by options
        if (this.onlyFileFilter(entry) || this.onlyDirectoryFilter(entry)) {
            return false;
        }
        if (this.isSkippedByAbsoluteNegativePatterns(entry, negativeRe)) {
            return false;
        }
        return this.isMatchToPatterns(entry.path, positiveRe) && !this.isMatchToPatterns(entry.path, negativeRe);
    };
    /**
     * Return true if the entry already has in the cross reader index.
     */
    EntryFilter.prototype.isDuplicateEntry = function (entry) {
        return this.index.has(entry.path);
    };
    /**
     * Create record in the cross reader index.
     */
    EntryFilter.prototype.createIndexRecord = function (entry) {
        this.index.set(entry.path, undefined);
    };
    /**
     * Returns true for non-files if the «onlyFiles» option is enabled.
     */
    EntryFilter.prototype.onlyFileFilter = function (entry) {
        return this.options.onlyFiles && !entry.isFile();
    };
    /**
     * Returns true for non-directories if the «onlyDirectories» option is enabled.
     */
    EntryFilter.prototype.onlyDirectoryFilter = function (entry) {
        return this.options.onlyDirectories && !entry.isDirectory();
    };
    /**
     * Return true when `absolute` option is enabled and matched to the negative patterns.
     */
    EntryFilter.prototype.isSkippedByAbsoluteNegativePatterns = function (entry, negativeRe) {
        if (!this.options.absolute) {
            return false;
        }
        var fullpath = pathUtils.makeAbsolute(this.options.cwd, entry.path);
        return this.isMatchToPatterns(fullpath, negativeRe);
    };
    /**
     * Return true when entry match to provided patterns.
     *
     * First, just trying to apply patterns to the path.
     * Second, trying to apply patterns to the path with final slash (need to micromatch to support «directory/**» patterns).
     */
    EntryFilter.prototype.isMatchToPatterns = function (filepath, patternsRe) {
        return patternUtils.matchAny(filepath, patternsRe) || patternUtils.matchAny(filepath + '/', patternsRe);
    };
    return EntryFilter;
}());
exports["default"] = EntryFilter;


/***/ }),

/***/ 1803:
/***/ (function(__unused_webpack_module, exports, __nccwpck_require__) {


var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
var readdir = __nccwpck_require__(9913);
var reader_1 = __nccwpck_require__(1220);
var fs_stream_1 = __nccwpck_require__(4734);
var ReaderAsync = /** @class */ (function (_super) {
    __extends(ReaderAsync, _super);
    function ReaderAsync() {
        return _super !== null && _super.apply(this, arguments) || this;
    }
    Object.defineProperty(ReaderAsync.prototype, "fsAdapter", {
        /**
         * Returns FileSystem adapter.
         */
        get: function () {
            return new fs_stream_1.default(this.options);
        },
        enumerable: true,
        configurable: true
    });
    /**
     * Use async API to read entries for Task.
     */
    ReaderAsync.prototype.read = function (task) {
        var _this = this;
        var root = this.getRootDirectory(task);
        var options = this.getReaderOptions(task);
        var entries = [];
        return new Promise(function (resolve, reject) {
            var stream = _this.api(root, task, options);
            stream.on('error', function (err) {
                _this.isEnoentCodeError(err) ? resolve([]) : reject(err);
                stream.pause();
            });
            stream.on('data', function (entry) { return entries.push(_this.transform(entry)); });
            stream.on('end', function () { return resolve(entries); });
        });
    };
    /**
     * Returns founded paths.
     */
    ReaderAsync.prototype.api = function (root, task, options) {
        if (task.dynamic) {
            return this.dynamicApi(root, options);
        }
        return this.staticApi(task, options);
    };
    /**
     * Api for dynamic tasks.
     */
    ReaderAsync.prototype.dynamicApi = function (root, options) {
        return readdir.readdirStreamStat(root, options);
    };
    /**
     * Api for static tasks.
     */
    ReaderAsync.prototype.staticApi = function (task, options) {
        return this.fsAdapter.read(task.patterns, options.filter);
    };
    return ReaderAsync;
}(reader_1.default));
exports["default"] = ReaderAsync;


/***/ }),

/***/ 2830:
/***/ (function(__unused_webpack_module, exports, __nccwpck_require__) {


var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
var stream = __nccwpck_require__(2781);
var readdir = __nccwpck_require__(9913);
var reader_1 = __nccwpck_require__(1220);
var fs_stream_1 = __nccwpck_require__(4734);
var TransformStream = /** @class */ (function (_super) {
    __extends(TransformStream, _super);
    function TransformStream(reader) {
        var _this = _super.call(this, { objectMode: true }) || this;
        _this.reader = reader;
        return _this;
    }
    TransformStream.prototype._transform = function (entry, _encoding, callback) {
        callback(null, this.reader.transform(entry));
    };
    return TransformStream;
}(stream.Transform));
var ReaderStream = /** @class */ (function (_super) {
    __extends(ReaderStream, _super);
    function ReaderStream() {
        return _super !== null && _super.apply(this, arguments) || this;
    }
    Object.defineProperty(ReaderStream.prototype, "fsAdapter", {
        /**
         * Returns FileSystem adapter.
         */
        get: function () {
            return new fs_stream_1.default(this.options);
        },
        enumerable: true,
        configurable: true
    });
    /**
     * Use stream API to read entries for Task.
     */
    ReaderStream.prototype.read = function (task) {
        var _this = this;
        var root = this.getRootDirectory(task);
        var options = this.getReaderOptions(task);
        var transform = new TransformStream(this);
        var readable = this.api(root, task, options);
        return readable
            .on('error', function (err) { return _this.isEnoentCodeError(err) ? null : transform.emit('error', err); })
            .pipe(transform);
    };
    /**
     * Returns founded paths.
     */
    ReaderStream.prototype.api = function (root, task, options) {
        if (task.dynamic) {
            return this.dynamicApi(root, options);
        }
        return this.staticApi(task, options);
    };
    /**
     * Api for dynamic tasks.
     */
    ReaderStream.prototype.dynamicApi = function (root, options) {
        return readdir.readdirStreamStat(root, options);
    };
    /**
     * Api for static tasks.
     */
    ReaderStream.prototype.staticApi = function (task, options) {
        return this.fsAdapter.read(task.patterns, options.filter);
    };
    return ReaderStream;
}(reader_1.default));
exports["default"] = ReaderStream;


/***/ }),

/***/ 647:
/***/ (function(__unused_webpack_module, exports, __nccwpck_require__) {


var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
var readdir = __nccwpck_require__(9913);
var reader_1 = __nccwpck_require__(1220);
var fs_sync_1 = __nccwpck_require__(6427);
var ReaderSync = /** @class */ (function (_super) {
    __extends(ReaderSync, _super);
    function ReaderSync() {
        return _super !== null && _super.apply(this, arguments) || this;
    }
    Object.defineProperty(ReaderSync.prototype, "fsAdapter", {
        /**
         * Returns FileSystem adapter.
         */
        get: function () {
            return new fs_sync_1.default(this.options);
        },
        enumerable: true,
        configurable: true
    });
    /**
     * Use sync API to read entries for Task.
     */
    ReaderSync.prototype.read = function (task) {
        var root = this.getRootDirectory(task);
        var options = this.getReaderOptions(task);
        try {
            var entries = this.api(root, task, options);
            return entries.map(this.transform, this);
        }
        catch (err) {
            if (this.isEnoentCodeError(err)) {
                return [];
            }
            throw err;
        }
    };
    /**
     * Returns founded paths.
     */
    ReaderSync.prototype.api = function (root, task, options) {
        if (task.dynamic) {
            return this.dynamicApi(root, options);
        }
        return this.staticApi(task, options);
    };
    /**
     * Api for dynamic tasks.
     */
    ReaderSync.prototype.dynamicApi = function (root, options) {
        return readdir.readdirSyncStat(root, options);
    };
    /**
     * Api for static tasks.
     */
    ReaderSync.prototype.staticApi = function (task, options) {
        return this.fsAdapter.read(task.patterns, options.filter);
    };
    return ReaderSync;
}(reader_1.default));
exports["default"] = ReaderSync;


/***/ }),

/***/ 1220:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
var path = __nccwpck_require__(1017);
var deep_1 = __nccwpck_require__(6983);
var entry_1 = __nccwpck_require__(1343);
var pathUtil = __nccwpck_require__(3873);
var Reader = /** @class */ (function () {
    function Reader(options) {
        this.options = options;
        this.micromatchOptions = this.getMicromatchOptions();
        this.entryFilter = new entry_1.default(options, this.micromatchOptions);
        this.deepFilter = new deep_1.default(options, this.micromatchOptions);
    }
    /**
     * Returns root path to scanner.
     */
    Reader.prototype.getRootDirectory = function (task) {
        return path.resolve(this.options.cwd, task.base);
    };
    /**
     * Returns options for reader.
     */
    Reader.prototype.getReaderOptions = function (task) {
        return {
            basePath: task.base === '.' ? '' : task.base,
            filter: this.entryFilter.getFilter(task.positive, task.negative),
            deep: this.deepFilter.getFilter(task.positive, task.negative),
            sep: '/'
        };
    };
    /**
     * Returns options for micromatch.
     */
    Reader.prototype.getMicromatchOptions = function () {
        return {
            dot: this.options.dot,
            nobrace: !this.options.brace,
            noglobstar: !this.options.globstar,
            noext: !this.options.extension,
            nocase: !this.options.case,
            matchBase: this.options.matchBase
        };
    };
    /**
     * Returns transformed entry.
     */
    Reader.prototype.transform = function (entry) {
        if (this.options.absolute) {
            entry.path = pathUtil.makeAbsolute(this.options.cwd, entry.path);
        }
        if (this.options.markDirectories && entry.isDirectory()) {
            entry.path += '/';
        }
        var item = this.options.stats ? entry : entry.path;
        if (this.options.transform === null) {
            return item;
        }
        return this.options.transform(item);
    };
    /**
     * Returns true if error has ENOENT code.
     */
    Reader.prototype.isEnoentCodeError = function (err) {
        return err.code === 'ENOENT';
    };
    return Reader;
}());
exports["default"] = Reader;


/***/ }),

/***/ 5325:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
/**
 * Flatten nested arrays (max depth is 2) into a non-nested array of non-array items.
 */
function flatten(items) {
    return items.reduce(function (collection, item) { return [].concat(collection, item); }, []);
}
exports.flatten = flatten;


/***/ }),

/***/ 3873:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
var path = __nccwpck_require__(1017);
/**
 * Returns «true» if the last partial of the path starting with a period.
 */
function isDotDirectory(filepath) {
    return path.basename(filepath).startsWith('.');
}
exports.isDotDirectory = isDotDirectory;
/**
 * Convert a windows-like path to a unix-style path.
 */
function normalize(filepath) {
    return filepath.replace(/\\/g, '/');
}
exports.normalize = normalize;
/**
 * Returns normalized absolute path of provided filepath.
 */
function makeAbsolute(cwd, filepath) {
    return normalize(path.resolve(cwd, filepath));
}
exports.makeAbsolute = makeAbsolute;


/***/ }),

/***/ 1221:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
var path = __nccwpck_require__(1017);
var globParent = __nccwpck_require__(4655);
var isGlob = __nccwpck_require__(4027);
var micromatch = __nccwpck_require__(6228);
var GLOBSTAR = '**';
/**
 * Return true for static pattern.
 */
function isStaticPattern(pattern) {
    return !isDynamicPattern(pattern);
}
exports.isStaticPattern = isStaticPattern;
/**
 * Return true for pattern that looks like glob.
 */
function isDynamicPattern(pattern) {
    return isGlob(pattern, { strict: false });
}
exports.isDynamicPattern = isDynamicPattern;
/**
 * Convert a windows «path» to a unix-style «path».
 */
function unixifyPattern(pattern) {
    return pattern.replace(/\\/g, '/');
}
exports.unixifyPattern = unixifyPattern;
/**
 * Returns negative pattern as positive pattern.
 */
function convertToPositivePattern(pattern) {
    return isNegativePattern(pattern) ? pattern.slice(1) : pattern;
}
exports.convertToPositivePattern = convertToPositivePattern;
/**
 * Returns positive pattern as negative pattern.
 */
function convertToNegativePattern(pattern) {
    return '!' + pattern;
}
exports.convertToNegativePattern = convertToNegativePattern;
/**
 * Return true if provided pattern is negative pattern.
 */
function isNegativePattern(pattern) {
    return pattern.startsWith('!') && pattern[1] !== '(';
}
exports.isNegativePattern = isNegativePattern;
/**
 * Return true if provided pattern is positive pattern.
 */
function isPositivePattern(pattern) {
    return !isNegativePattern(pattern);
}
exports.isPositivePattern = isPositivePattern;
/**
 * Extracts negative patterns from array of patterns.
 */
function getNegativePatterns(patterns) {
    return patterns.filter(isNegativePattern);
}
exports.getNegativePatterns = getNegativePatterns;
/**
 * Extracts positive patterns from array of patterns.
 */
function getPositivePatterns(patterns) {
    return patterns.filter(isPositivePattern);
}
exports.getPositivePatterns = getPositivePatterns;
/**
 * Extract base directory from provided pattern.
 */
function getBaseDirectory(pattern) {
    return globParent(pattern);
}
exports.getBaseDirectory = getBaseDirectory;
/**
 * Return true if provided pattern has globstar.
 */
function hasGlobStar(pattern) {
    return pattern.indexOf(GLOBSTAR) !== -1;
}
exports.hasGlobStar = hasGlobStar;
/**
 * Return true if provided pattern ends with slash and globstar.
 */
function endsWithSlashGlobStar(pattern) {
    return pattern.endsWith('/' + GLOBSTAR);
}
exports.endsWithSlashGlobStar = endsWithSlashGlobStar;
/**
 * Returns «true» when pattern ends with a slash and globstar or the last partial of the pattern is static pattern.
 */
function isAffectDepthOfReadingPattern(pattern) {
    var basename = path.basename(pattern);
    return endsWithSlashGlobStar(pattern) || isStaticPattern(basename);
}
exports.isAffectDepthOfReadingPattern = isAffectDepthOfReadingPattern;
/**
 * Return naive depth of provided pattern without depth of the base directory.
 */
function getNaiveDepth(pattern) {
    var base = getBaseDirectory(pattern);
    var patternDepth = pattern.split('/').length;
    var patternBaseDepth = base.split('/').length;
    /**
     * This is a hack for pattern that has no base directory.
     *
     * This is related to the `*\something\*` pattern.
     */
    if (base === '.') {
        return patternDepth - patternBaseDepth;
    }
    return patternDepth - patternBaseDepth - 1;
}
exports.getNaiveDepth = getNaiveDepth;
/**
 * Return max naive depth of provided patterns without depth of the base directory.
 */
function getMaxNaivePatternsDepth(patterns) {
    return patterns.reduce(function (max, pattern) {
        var depth = getNaiveDepth(pattern);
        return depth > max ? depth : max;
    }, 0);
}
exports.getMaxNaivePatternsDepth = getMaxNaivePatternsDepth;
/**
 * Make RegExp for provided pattern.
 */
function makeRe(pattern, options) {
    return micromatch.makeRe(pattern, options);
}
exports.makeRe = makeRe;
/**
 * Convert patterns to regexps.
 */
function convertPatternsToRe(patterns, options) {
    return patterns.map(function (pattern) { return makeRe(pattern, options); });
}
exports.convertPatternsToRe = convertPatternsToRe;
/**
 * Returns true if the entry match any of the given RegExp's.
 */
function matchAny(entry, patternsRe) {
    return patternsRe.some(function (patternRe) { return patternRe.test(entry); });
}
exports.matchAny = matchAny;


/***/ }),

/***/ 8382:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
var merge2 = __nccwpck_require__(2578);
/**
 * Merge multiple streams and propagate their errors into one stream in parallel.
 */
function merge(streams) {
    var mergedStream = merge2(streams);
    streams.forEach(function (stream) {
        stream.on('error', function (err) { return mergedStream.emit('error', err); });
    });
    return mergedStream;
}
exports.merge = merge;


/***/ }),

/***/ 6330:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * fill-range <https://github.com/jonschlinkert/fill-range>
 *
 * Copyright (c) 2014-2015, 2017, Jon Schlinkert.
 * Released under the MIT License.
 */



var util = __nccwpck_require__(3837);
var isNumber = __nccwpck_require__(5680);
var extend = __nccwpck_require__(7512);
var repeat = __nccwpck_require__(6976);
var toRegex = __nccwpck_require__(1861);

/**
 * Return a range of numbers or letters.
 *
 * @param  {String} `start` Start of the range
 * @param  {String} `stop` End of the range
 * @param  {String} `step` Increment or decrement to use.
 * @param  {Function} `fn` Custom function to modify each element in the range.
 * @return {Array}
 */

function fillRange(start, stop, step, options) {
  if (typeof start === 'undefined') {
    return [];
  }

  if (typeof stop === 'undefined' || start === stop) {
    // special case, for handling negative zero
    var isString = typeof start === 'string';
    if (isNumber(start) && !toNumber(start)) {
      return [isString ? '0' : 0];
    }
    return [start];
  }

  if (typeof step !== 'number' && typeof step !== 'string') {
    options = step;
    step = undefined;
  }

  if (typeof options === 'function') {
    options = { transform: options };
  }

  var opts = extend({step: step}, options);
  if (opts.step && !isValidNumber(opts.step)) {
    if (opts.strictRanges === true) {
      throw new TypeError('expected options.step to be a number');
    }
    return [];
  }

  opts.isNumber = isValidNumber(start) && isValidNumber(stop);
  if (!opts.isNumber && !isValid(start, stop)) {
    if (opts.strictRanges === true) {
      throw new RangeError('invalid range arguments: ' + util.inspect([start, stop]));
    }
    return [];
  }

  opts.isPadded = isPadded(start) || isPadded(stop);
  opts.toString = opts.stringify
    || typeof opts.step === 'string'
    || typeof start === 'string'
    || typeof stop === 'string'
    || !opts.isNumber;

  if (opts.isPadded) {
    opts.maxLength = Math.max(String(start).length, String(stop).length);
  }

  // support legacy minimatch/fill-range options
  if (typeof opts.optimize === 'boolean') opts.toRegex = opts.optimize;
  if (typeof opts.makeRe === 'boolean') opts.toRegex = opts.makeRe;
  return expand(start, stop, opts);
}

function expand(start, stop, options) {
  var a = options.isNumber ? toNumber(start) : start.charCodeAt(0);
  var b = options.isNumber ? toNumber(stop) : stop.charCodeAt(0);

  var step = Math.abs(toNumber(options.step)) || 1;
  if (options.toRegex && step === 1) {
    return toRange(a, b, start, stop, options);
  }

  var zero = {greater: [], lesser: []};
  var asc = a < b;
  var arr = new Array(Math.round((asc ? b - a : a - b) / step));
  var idx = 0;

  while (asc ? a <= b : a >= b) {
    var val = options.isNumber ? a : String.fromCharCode(a);
    if (options.toRegex && (val >= 0 || !options.isNumber)) {
      zero.greater.push(val);
    } else {
      zero.lesser.push(Math.abs(val));
    }

    if (options.isPadded) {
      val = zeros(val, options);
    }

    if (options.toString) {
      val = String(val);
    }

    if (typeof options.transform === 'function') {
      arr[idx++] = options.transform(val, a, b, step, idx, arr, options);
    } else {
      arr[idx++] = val;
    }

    if (asc) {
      a += step;
    } else {
      a -= step;
    }
  }

  if (options.toRegex === true) {
    return toSequence(arr, zero, options);
  }
  return arr;
}

function toRange(a, b, start, stop, options) {
  if (options.isPadded) {
    return toRegex(start, stop, options);
  }

  if (options.isNumber) {
    return toRegex(Math.min(a, b), Math.max(a, b), options);
  }

  var start = String.fromCharCode(Math.min(a, b));
  var stop = String.fromCharCode(Math.max(a, b));
  return '[' + start + '-' + stop + ']';
}

function toSequence(arr, zeros, options) {
  var greater = '', lesser = '';
  if (zeros.greater.length) {
    greater = zeros.greater.join('|');
  }
  if (zeros.lesser.length) {
    lesser = '-(' + zeros.lesser.join('|') + ')';
  }
  var res = greater && lesser
    ? greater + '|' + lesser
    : greater || lesser;

  if (options.capture) {
    return '(' + res + ')';
  }
  return res;
}

function zeros(val, options) {
  if (options.isPadded) {
    var str = String(val);
    var len = str.length;
    var dash = '';
    if (str.charAt(0) === '-') {
      dash = '-';
      str = str.slice(1);
    }
    var diff = options.maxLength - len;
    var pad = repeat('0', diff);
    val = (dash + pad + str);
  }
  if (options.stringify) {
    return String(val);
  }
  return val;
}

function toNumber(val) {
  return Number(val) || 0;
}

function isPadded(str) {
  return /^-?0\d/.test(str);
}

function isValid(min, max) {
  return (isValidNumber(min) || isValidLetter(min))
      && (isValidNumber(max) || isValidLetter(max));
}

function isValidLetter(ch) {
  return typeof ch === 'string' && ch.length === 1 && /^\w+$/.test(ch);
}

function isValidNumber(n) {
  return isNumber(n) && !/\./.test(n);
}

/**
 * Expose `fillRange`
 * @type {Function}
 */

module.exports = fillRange;


/***/ }),

/***/ 7198:
/***/ ((module) => {

/*!
 * for-in <https://github.com/jonschlinkert/for-in>
 *
 * Copyright (c) 2014-2017, Jon Schlinkert.
 * Released under the MIT License.
 */



module.exports = function forIn(obj, fn, thisArg) {
  for (var key in obj) {
    if (fn.call(thisArg, obj[key], key, obj) === false) {
      break;
    }
  }
};


/***/ }),

/***/ 4838:
/***/ ((module, exports, __nccwpck_require__) => {

/*!
 * fragment-cache <https://github.com/jonschlinkert/fragment-cache>
 *
 * Copyright (c) 2016-2017, Jon Schlinkert.
 * Released under the MIT License.
 */



var MapCache = __nccwpck_require__(4643);

/**
 * Create a new `FragmentCache` with an optional object to use for `caches`.
 *
 * ```js
 * var fragment = new FragmentCache();
 * ```
 * @name FragmentCache
 * @param {String} `cacheName`
 * @return {Object} Returns the [map-cache][] instance.
 * @api public
 */

function FragmentCache(caches) {
  this.caches = caches || {};
}

/**
 * Prototype
 */

FragmentCache.prototype = {

  /**
   * Get cache `name` from the `fragment.caches` object. Creates a new
   * `MapCache` if it doesn't already exist.
   *
   * ```js
   * var cache = fragment.cache('files');
   * console.log(fragment.caches.hasOwnProperty('files'));
   * //=> true
   * ```
   * @name .cache
   * @param {String} `cacheName`
   * @return {Object} Returns the [map-cache][] instance.
   * @api public
   */

  cache: function(cacheName) {
    return this.caches[cacheName] || (this.caches[cacheName] = new MapCache());
  },

  /**
   * Set a value for property `key` on cache `name`
   *
   * ```js
   * fragment.set('files', 'somefile.js', new File({path: 'somefile.js'}));
   * ```
   * @name .set
   * @param {String} `name`
   * @param {String} `key` Property name to set
   * @param {any} `val` The value of `key`
   * @return {Object} The cache instance for chaining
   * @api public
   */

  set: function(cacheName, key, val) {
    var cache = this.cache(cacheName);
    cache.set(key, val);
    return cache;
  },

  /**
   * Returns true if a non-undefined value is set for `key` on fragment cache `name`.
   *
   * ```js
   * var cache = fragment.cache('files');
   * cache.set('somefile.js');
   *
   * console.log(cache.has('somefile.js'));
   * //=> true
   *
   * console.log(cache.has('some-other-file.js'));
   * //=> false
   * ```
   * @name .has
   * @param {String} `name` Cache name
   * @param {String} `key` Optionally specify a property to check for on cache `name`
   * @return {Boolean}
   * @api public
   */

  has: function(cacheName, key) {
    return typeof this.get(cacheName, key) !== 'undefined';
  },

  /**
   * Get `name`, or if specified, the value of `key`. Invokes the [cache]() method,
   * so that cache `name` will be created it doesn't already exist. If `key` is not passed,
   * the entire cache (`name`) is returned.
   *
   * ```js
   * var Vinyl = require('vinyl');
   * var cache = fragment.cache('files');
   * cache.set('somefile.js', new Vinyl({path: 'somefile.js'}));
   * console.log(cache.get('somefile.js'));
   * //=> <File "somefile.js">
   * ```
   * @name .get
   * @param {String} `name`
   * @return {Object} Returns cache `name`, or the value of `key` if specified
   * @api public
   */

  get: function(name, key) {
    var cache = this.cache(name);
    if (typeof key === 'string') {
      return cache.get(key);
    }
    return cache;
  }
};

/**
 * Expose `FragmentCache`
 */

exports = module.exports = FragmentCache;


/***/ }),

/***/ 6863:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

module.exports = realpath
realpath.realpath = realpath
realpath.sync = realpathSync
realpath.realpathSync = realpathSync
realpath.monkeypatch = monkeypatch
realpath.unmonkeypatch = unmonkeypatch

var fs = __nccwpck_require__(7147)
var origRealpath = fs.realpath
var origRealpathSync = fs.realpathSync

var version = process.version
var ok = /^v[0-5]\./.test(version)
var old = __nccwpck_require__(1734)

function newError (er) {
  return er && er.syscall === 'realpath' && (
    er.code === 'ELOOP' ||
    er.code === 'ENOMEM' ||
    er.code === 'ENAMETOOLONG'
  )
}

function realpath (p, cache, cb) {
  if (ok) {
    return origRealpath(p, cache, cb)
  }

  if (typeof cache === 'function') {
    cb = cache
    cache = null
  }
  origRealpath(p, cache, function (er, result) {
    if (newError(er)) {
      old.realpath(p, cache, cb)
    } else {
      cb(er, result)
    }
  })
}

function realpathSync (p, cache) {
  if (ok) {
    return origRealpathSync(p, cache)
  }

  try {
    return origRealpathSync(p, cache)
  } catch (er) {
    if (newError(er)) {
      return old.realpathSync(p, cache)
    } else {
      throw er
    }
  }
}

function monkeypatch () {
  fs.realpath = realpath
  fs.realpathSync = realpathSync
}

function unmonkeypatch () {
  fs.realpath = origRealpath
  fs.realpathSync = origRealpathSync
}


/***/ }),

/***/ 1734:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {

// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var pathModule = __nccwpck_require__(1017);
var isWindows = process.platform === 'win32';
var fs = __nccwpck_require__(7147);

// JavaScript implementation of realpath, ported from node pre-v6

var DEBUG = process.env.NODE_DEBUG && /fs/.test(process.env.NODE_DEBUG);

function rethrow() {
  // Only enable in debug mode. A backtrace uses ~1000 bytes of heap space and
  // is fairly slow to generate.
  var callback;
  if (DEBUG) {
    var backtrace = new Error;
    callback = debugCallback;
  } else
    callback = missingCallback;

  return callback;

  function debugCallback(err) {
    if (err) {
      backtrace.message = err.message;
      err = backtrace;
      missingCallback(err);
    }
  }

  function missingCallback(err) {
    if (err) {
      if (process.throwDeprecation)
        throw err;  // Forgot a callback but don't know where? Use NODE_DEBUG=fs
      else if (!process.noDeprecation) {
        var msg = 'fs: missing callback ' + (err.stack || err.message);
        if (process.traceDeprecation)
          console.trace(msg);
        else
          console.error(msg);
      }
    }
  }
}

function maybeCallback(cb) {
  return typeof cb === 'function' ? cb : rethrow();
}

var normalize = pathModule.normalize;

// Regexp that finds the next partion of a (partial) path
// result is [base_with_slash, base], e.g. ['somedir/', 'somedir']
if (isWindows) {
  var nextPartRe = /(.*?)(?:[\/\\]+|$)/g;
} else {
  var nextPartRe = /(.*?)(?:[\/]+|$)/g;
}

// Regex to find the device root, including trailing slash. E.g. 'c:\\'.
if (isWindows) {
  var splitRootRe = /^(?:[a-zA-Z]:|[\\\/]{2}[^\\\/]+[\\\/][^\\\/]+)?[\\\/]*/;
} else {
  var splitRootRe = /^[\/]*/;
}

exports.realpathSync = function realpathSync(p, cache) {
  // make p is absolute
  p = pathModule.resolve(p);

  if (cache && Object.prototype.hasOwnProperty.call(cache, p)) {
    return cache[p];
  }

  var original = p,
      seenLinks = {},
      knownHard = {};

  // current character position in p
  var pos;
  // the partial path so far, including a trailing slash if any
  var current;
  // the partial path without a trailing slash (except when pointing at a root)
  var base;
  // the partial path scanned in the previous round, with slash
  var previous;

  start();

  function start() {
    // Skip over roots
    var m = splitRootRe.exec(p);
    pos = m[0].length;
    current = m[0];
    base = m[0];
    previous = '';

    // On windows, check that the root exists. On unix there is no need.
    if (isWindows && !knownHard[base]) {
      fs.lstatSync(base);
      knownHard[base] = true;
    }
  }

  // walk down the path, swapping out linked pathparts for their real
  // values
  // NB: p.length changes.
  while (pos < p.length) {
    // find the next part
    nextPartRe.lastIndex = pos;
    var result = nextPartRe.exec(p);
    previous = current;
    current += result[0];
    base = previous + result[1];
    pos = nextPartRe.lastIndex;

    // continue if not a symlink
    if (knownHard[base] || (cache && cache[base] === base)) {
      continue;
    }

    var resolvedLink;
    if (cache && Object.prototype.hasOwnProperty.call(cache, base)) {
      // some known symbolic link.  no need to stat again.
      resolvedLink = cache[base];
    } else {
      var stat = fs.lstatSync(base);
      if (!stat.isSymbolicLink()) {
        knownHard[base] = true;
        if (cache) cache[base] = base;
        continue;
      }

      // read the link if it wasn't read before
      // dev/ino always return 0 on windows, so skip the check.
      var linkTarget = null;
      if (!isWindows) {
        var id = stat.dev.toString(32) + ':' + stat.ino.toString(32);
        if (seenLinks.hasOwnProperty(id)) {
          linkTarget = seenLinks[id];
        }
      }
      if (linkTarget === null) {
        fs.statSync(base);
        linkTarget = fs.readlinkSync(base);
      }
      resolvedLink = pathModule.resolve(previous, linkTarget);
      // track this, if given a cache.
      if (cache) cache[base] = resolvedLink;
      if (!isWindows) seenLinks[id] = linkTarget;
    }

    // resolve the link, then start over
    p = pathModule.resolve(resolvedLink, p.slice(pos));
    start();
  }

  if (cache) cache[original] = p;

  return p;
};


exports.realpath = function realpath(p, cache, cb) {
  if (typeof cb !== 'function') {
    cb = maybeCallback(cache);
    cache = null;
  }

  // make p is absolute
  p = pathModule.resolve(p);

  if (cache && Object.prototype.hasOwnProperty.call(cache, p)) {
    return process.nextTick(cb.bind(null, null, cache[p]));
  }

  var original = p,
      seenLinks = {},
      knownHard = {};

  // current character position in p
  var pos;
  // the partial path so far, including a trailing slash if any
  var current;
  // the partial path without a trailing slash (except when pointing at a root)
  var base;
  // the partial path scanned in the previous round, with slash
  var previous;

  start();

  function start() {
    // Skip over roots
    var m = splitRootRe.exec(p);
    pos = m[0].length;
    current = m[0];
    base = m[0];
    previous = '';

    // On windows, check that the root exists. On unix there is no need.
    if (isWindows && !knownHard[base]) {
      fs.lstat(base, function(err) {
        if (err) return cb(err);
        knownHard[base] = true;
        LOOP();
      });
    } else {
      process.nextTick(LOOP);
    }
  }

  // walk down the path, swapping out linked pathparts for their real
  // values
  function LOOP() {
    // stop if scanned past end of path
    if (pos >= p.length) {
      if (cache) cache[original] = p;
      return cb(null, p);
    }

    // find the next part
    nextPartRe.lastIndex = pos;
    var result = nextPartRe.exec(p);
    previous = current;
    current += result[0];
    base = previous + result[1];
    pos = nextPartRe.lastIndex;

    // continue if not a symlink
    if (knownHard[base] || (cache && cache[base] === base)) {
      return process.nextTick(LOOP);
    }

    if (cache && Object.prototype.hasOwnProperty.call(cache, base)) {
      // known symbolic link.  no need to stat again.
      return gotResolvedLink(cache[base]);
    }

    return fs.lstat(base, gotStat);
  }

  function gotStat(err, stat) {
    if (err) return cb(err);

    // if not a symlink, skip to the next path part
    if (!stat.isSymbolicLink()) {
      knownHard[base] = true;
      if (cache) cache[base] = base;
      return process.nextTick(LOOP);
    }

    // stat & read the link if not read before
    // call gotTarget as soon as the link target is known
    // dev/ino always return 0 on windows, so skip the check.
    if (!isWindows) {
      var id = stat.dev.toString(32) + ':' + stat.ino.toString(32);
      if (seenLinks.hasOwnProperty(id)) {
        return gotTarget(null, seenLinks[id], base);
      }
    }
    fs.stat(base, function(err) {
      if (err) return cb(err);

      fs.readlink(base, function(err, target) {
        if (!isWindows) seenLinks[id] = target;
        gotTarget(err, target);
      });
    });
  }

  function gotTarget(err, target, base) {
    if (err) return cb(err);

    var resolvedLink = pathModule.resolve(previous, target);
    if (cache) cache[base] = resolvedLink;
    gotResolvedLink(resolvedLink);
  }

  function gotResolvedLink(resolvedLink) {
    // resolve the link, then start over
    p = pathModule.resolve(resolvedLink, p.slice(pos));
    start();
  }
};


/***/ }),

/***/ 9611:
/***/ ((module) => {

/*!
 * get-value <https://github.com/jonschlinkert/get-value>
 *
 * Copyright (c) 2014-2015, Jon Schlinkert.
 * Licensed under the MIT License.
 */

module.exports = function(obj, prop, a, b, c) {
  if (!isObject(obj) || !prop) {
    return obj;
  }

  prop = toString(prop);

  // allowing for multiple properties to be passed as
  // a string or array, but much faster (3-4x) than doing
  // `[].slice.call(arguments)`
  if (a) prop += '.' + toString(a);
  if (b) prop += '.' + toString(b);
  if (c) prop += '.' + toString(c);

  if (prop in obj) {
    return obj[prop];
  }

  var segs = prop.split('.');
  var len = segs.length;
  var i = -1;

  while (obj && (++i < len)) {
    var key = segs[i];
    while (key[key.length - 1] === '\\') {
      key = key.slice(0, -1) + '.' + segs[++i];
    }
    obj = obj[key];
  }
  return obj;
};

function isObject(val) {
  return val !== null && (typeof val === 'object' || typeof val === 'function');
}

function toString(val) {
  if (!val) return '';
  if (Array.isArray(val)) {
    return val.join('.');
  }
  return val;
}


/***/ }),

/***/ 4655:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var path = __nccwpck_require__(1017);
var isglob = __nccwpck_require__(4466);
var pathDirname = __nccwpck_require__(7610);
var isWin32 = (__nccwpck_require__(2037).platform)() === 'win32';

module.exports = function globParent(str) {
	// flip windows path separators
	if (isWin32 && str.indexOf('/') < 0) str = str.split('\\').join('/');

	// special case for strings ending in enclosure containing path separator
	if (/[\{\[].*[\/]*.*[\}\]]$/.test(str)) str += '/';

	// preserves full path in case of trailing path separator
	str += 'a';

	// remove path parts that are globby
	do {str = pathDirname.posix(str)}
	while (isglob(str) || /(^|[^\\])([\{\[]|\([^\)]+$)/.test(str));

	// remove escape chars and return result
	return str.replace(/\\([\*\?\|\[\]\(\)\{\}])/g, '$1');
};


/***/ }),

/***/ 7117:
/***/ ((module) => {

module.exports = function (glob, opts) {
  if (typeof glob !== 'string') {
    throw new TypeError('Expected a string');
  }

  var str = String(glob);

  // The regexp we are building, as a string.
  var reStr = "";

  // Whether we are matching so called "extended" globs (like bash) and should
  // support single character matching, matching ranges of characters, group
  // matching, etc.
  var extended = opts ? !!opts.extended : false;

  // When globstar is _false_ (default), '/foo/*' is translated a regexp like
  // '^\/foo\/.*$' which will match any string beginning with '/foo/'
  // When globstar is _true_, '/foo/*' is translated to regexp like
  // '^\/foo\/[^/]*$' which will match any string beginning with '/foo/' BUT
  // which does not have a '/' to the right of it.
  // E.g. with '/foo/*' these will match: '/foo/bar', '/foo/bar.txt' but
  // these will not '/foo/bar/baz', '/foo/bar/baz.txt'
  // Lastely, when globstar is _true_, '/foo/**' is equivelant to '/foo/*' when
  // globstar is _false_
  var globstar = opts ? !!opts.globstar : false;

  // If we are doing extended matching, this boolean is true when we are inside
  // a group (eg {*.html,*.js}), and false otherwise.
  var inGroup = false;

  // RegExp flags (eg "i" ) to pass in to RegExp constructor.
  var flags = opts && typeof( opts.flags ) === "string" ? opts.flags : "";

  var c;
  for (var i = 0, len = str.length; i < len; i++) {
    c = str[i];

    switch (c) {
    case "\\":
    case "/":
    case "$":
    case "^":
    case "+":
    case ".":
    case "(":
    case ")":
    case "=":
    case "!":
    case "|":
      reStr += "\\" + c;
      break;

    case "?":
      if (extended) {
        reStr += ".";
	    break;
      }

    case "[":
    case "]":
      if (extended) {
        reStr += c;
	    break;
      }

    case "{":
      if (extended) {
        inGroup = true;
	    reStr += "(";
	    break;
      }

    case "}":
      if (extended) {
        inGroup = false;
	    reStr += ")";
	    break;
      }

    case ",":
      if (inGroup) {
        reStr += "|";
	    break;
      }
      reStr += "\\" + c;
      break;

    case "*":
      // Move over all consecutive "*"'s.
      // Also store the previous and next characters
      var prevChar = str[i - 1];
      var starCount = 1;
      while(str[i + 1] === "*") {
        starCount++;
        i++;
      }
      var nextChar = str[i + 1];

      if (!globstar) {
        // globstar is disabled, so treat any number of "*" as one
        reStr += ".*";
      } else {
        // globstar is enabled, so determine if this is a globstar segment
        var isGlobstar = starCount > 1                      // multiple "*"'s
          && (prevChar === "/" || prevChar === undefined)   // from the start of the segment
          && (nextChar === "/" || nextChar === undefined)   // to the end of the segment

        if (isGlobstar) {
          // it's a globstar, so match zero or more path segments
          reStr += "(?:[^/]*(?:\/|$))*";
          i++; // move over the "/"
        } else {
          // it's not a globstar, so only match one path segment
          reStr += "[^/]*";
        }
      }
      break;

    default:
      reStr += c;
    }
  }

  // When regexp 'g' flag is specified don't
  // constrain the regular expression with ^ & $
  if (!flags || !~flags.indexOf('g')) {
    reStr = "^" + reStr + "$";
  }

  return new RegExp(reStr, flags);
};


/***/ }),

/***/ 7625:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {

exports.setopts = setopts
exports.ownProp = ownProp
exports.makeAbs = makeAbs
exports.finish = finish
exports.mark = mark
exports.isIgnored = isIgnored
exports.childrenIgnored = childrenIgnored

function ownProp (obj, field) {
  return Object.prototype.hasOwnProperty.call(obj, field)
}

var fs = __nccwpck_require__(7147)
var path = __nccwpck_require__(1017)
var minimatch = __nccwpck_require__(3973)
var isAbsolute = __nccwpck_require__(8714)
var Minimatch = minimatch.Minimatch

function alphasort (a, b) {
  return a.localeCompare(b, 'en')
}

function setupIgnores (self, options) {
  self.ignore = options.ignore || []

  if (!Array.isArray(self.ignore))
    self.ignore = [self.ignore]

  if (self.ignore.length) {
    self.ignore = self.ignore.map(ignoreMap)
  }
}

// ignore patterns are always in dot:true mode.
function ignoreMap (pattern) {
  var gmatcher = null
  if (pattern.slice(-3) === '/**') {
    var gpattern = pattern.replace(/(\/\*\*)+$/, '')
    gmatcher = new Minimatch(gpattern, { dot: true })
  }

  return {
    matcher: new Minimatch(pattern, { dot: true }),
    gmatcher: gmatcher
  }
}

function setopts (self, pattern, options) {
  if (!options)
    options = {}

  // base-matching: just use globstar for that.
  if (options.matchBase && -1 === pattern.indexOf("/")) {
    if (options.noglobstar) {
      throw new Error("base matching requires globstar")
    }
    pattern = "**/" + pattern
  }

  self.silent = !!options.silent
  self.pattern = pattern
  self.strict = options.strict !== false
  self.realpath = !!options.realpath
  self.realpathCache = options.realpathCache || Object.create(null)
  self.follow = !!options.follow
  self.dot = !!options.dot
  self.mark = !!options.mark
  self.nodir = !!options.nodir
  if (self.nodir)
    self.mark = true
  self.sync = !!options.sync
  self.nounique = !!options.nounique
  self.nonull = !!options.nonull
  self.nosort = !!options.nosort
  self.nocase = !!options.nocase
  self.stat = !!options.stat
  self.noprocess = !!options.noprocess
  self.absolute = !!options.absolute
  self.fs = options.fs || fs

  self.maxLength = options.maxLength || Infinity
  self.cache = options.cache || Object.create(null)
  self.statCache = options.statCache || Object.create(null)
  self.symlinks = options.symlinks || Object.create(null)

  setupIgnores(self, options)

  self.changedCwd = false
  var cwd = process.cwd()
  if (!ownProp(options, "cwd"))
    self.cwd = cwd
  else {
    self.cwd = path.resolve(options.cwd)
    self.changedCwd = self.cwd !== cwd
  }

  self.root = options.root || path.resolve(self.cwd, "/")
  self.root = path.resolve(self.root)
  if (process.platform === "win32")
    self.root = self.root.replace(/\\/g, "/")

  // TODO: is an absolute `cwd` supposed to be resolved against `root`?
  // e.g. { cwd: '/test', root: __dirname } === path.join(__dirname, '/test')
  self.cwdAbs = isAbsolute(self.cwd) ? self.cwd : makeAbs(self, self.cwd)
  if (process.platform === "win32")
    self.cwdAbs = self.cwdAbs.replace(/\\/g, "/")
  self.nomount = !!options.nomount

  // disable comments and negation in Minimatch.
  // Note that they are not supported in Glob itself anyway.
  options.nonegate = true
  options.nocomment = true

  self.minimatch = new Minimatch(pattern, options)
  self.options = self.minimatch.options
}

function finish (self) {
  var nou = self.nounique
  var all = nou ? [] : Object.create(null)

  for (var i = 0, l = self.matches.length; i < l; i ++) {
    var matches = self.matches[i]
    if (!matches || Object.keys(matches).length === 0) {
      if (self.nonull) {
        // do like the shell, and spit out the literal glob
        var literal = self.minimatch.globSet[i]
        if (nou)
          all.push(literal)
        else
          all[literal] = true
      }
    } else {
      // had matches
      var m = Object.keys(matches)
      if (nou)
        all.push.apply(all, m)
      else
        m.forEach(function (m) {
          all[m] = true
        })
    }
  }

  if (!nou)
    all = Object.keys(all)

  if (!self.nosort)
    all = all.sort(alphasort)

  // at *some* point we statted all of these
  if (self.mark) {
    for (var i = 0; i < all.length; i++) {
      all[i] = self._mark(all[i])
    }
    if (self.nodir) {
      all = all.filter(function (e) {
        var notDir = !(/\/$/.test(e))
        var c = self.cache[e] || self.cache[makeAbs(self, e)]
        if (notDir && c)
          notDir = c !== 'DIR' && !Array.isArray(c)
        return notDir
      })
    }
  }

  if (self.ignore.length)
    all = all.filter(function(m) {
      return !isIgnored(self, m)
    })

  self.found = all
}

function mark (self, p) {
  var abs = makeAbs(self, p)
  var c = self.cache[abs]
  var m = p
  if (c) {
    var isDir = c === 'DIR' || Array.isArray(c)
    var slash = p.slice(-1) === '/'

    if (isDir && !slash)
      m += '/'
    else if (!isDir && slash)
      m = m.slice(0, -1)

    if (m !== p) {
      var mabs = makeAbs(self, m)
      self.statCache[mabs] = self.statCache[abs]
      self.cache[mabs] = self.cache[abs]
    }
  }

  return m
}

// lotta situps...
function makeAbs (self, f) {
  var abs = f
  if (f.charAt(0) === '/') {
    abs = path.join(self.root, f)
  } else if (isAbsolute(f) || f === '') {
    abs = f
  } else if (self.changedCwd) {
    abs = path.resolve(self.cwd, f)
  } else {
    abs = path.resolve(f)
  }

  if (process.platform === 'win32')
    abs = abs.replace(/\\/g, '/')

  return abs
}


// Return true, if pattern ends with globstar '**', for the accompanying parent directory.
// Ex:- If node_modules/** is the pattern, add 'node_modules' to ignore list along with it's contents
function isIgnored (self, path) {
  if (!self.ignore.length)
    return false

  return self.ignore.some(function(item) {
    return item.matcher.match(path) || !!(item.gmatcher && item.gmatcher.match(path))
  })
}

function childrenIgnored (self, path) {
  if (!self.ignore.length)
    return false

  return self.ignore.some(function(item) {
    return !!(item.gmatcher && item.gmatcher.match(path))
  })
}


/***/ }),

/***/ 1957:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

// Approach:
//
// 1. Get the minimatch set
// 2. For each pattern in the set, PROCESS(pattern, false)
// 3. Store matches per-set, then uniq them
//
// PROCESS(pattern, inGlobStar)
// Get the first [n] items from pattern that are all strings
// Join these together.  This is PREFIX.
//   If there is no more remaining, then stat(PREFIX) and
//   add to matches if it succeeds.  END.
//
// If inGlobStar and PREFIX is symlink and points to dir
//   set ENTRIES = []
// else readdir(PREFIX) as ENTRIES
//   If fail, END
//
// with ENTRIES
//   If pattern[n] is GLOBSTAR
//     // handle the case where the globstar match is empty
//     // by pruning it out, and testing the resulting pattern
//     PROCESS(pattern[0..n] + pattern[n+1 .. $], false)
//     // handle other cases.
//     for ENTRY in ENTRIES (not dotfiles)
//       // attach globstar + tail onto the entry
//       // Mark that this entry is a globstar match
//       PROCESS(pattern[0..n] + ENTRY + pattern[n .. $], true)
//
//   else // not globstar
//     for ENTRY in ENTRIES (not dotfiles, unless pattern[n] is dot)
//       Test ENTRY against pattern[n]
//       If fails, continue
//       If passes, PROCESS(pattern[0..n] + item + pattern[n+1 .. $])
//
// Caveat:
//   Cache all stats and readdirs results to minimize syscall.  Since all
//   we ever care about is existence and directory-ness, we can just keep
//   `true` for files, and [children,...] for directories, or `false` for
//   things that don't exist.

module.exports = glob

var rp = __nccwpck_require__(6863)
var minimatch = __nccwpck_require__(3973)
var Minimatch = minimatch.Minimatch
var inherits = __nccwpck_require__(4124)
var EE = (__nccwpck_require__(2361).EventEmitter)
var path = __nccwpck_require__(1017)
var assert = __nccwpck_require__(9491)
var isAbsolute = __nccwpck_require__(8714)
var globSync = __nccwpck_require__(9010)
var common = __nccwpck_require__(7625)
var setopts = common.setopts
var ownProp = common.ownProp
var inflight = __nccwpck_require__(2492)
var util = __nccwpck_require__(3837)
var childrenIgnored = common.childrenIgnored
var isIgnored = common.isIgnored

var once = __nccwpck_require__(1223)

function glob (pattern, options, cb) {
  if (typeof options === 'function') cb = options, options = {}
  if (!options) options = {}

  if (options.sync) {
    if (cb)
      throw new TypeError('callback provided to sync glob')
    return globSync(pattern, options)
  }

  return new Glob(pattern, options, cb)
}

glob.sync = globSync
var GlobSync = glob.GlobSync = globSync.GlobSync

// old api surface
glob.glob = glob

function extend (origin, add) {
  if (add === null || typeof add !== 'object') {
    return origin
  }

  var keys = Object.keys(add)
  var i = keys.length
  while (i--) {
    origin[keys[i]] = add[keys[i]]
  }
  return origin
}

glob.hasMagic = function (pattern, options_) {
  var options = extend({}, options_)
  options.noprocess = true

  var g = new Glob(pattern, options)
  var set = g.minimatch.set

  if (!pattern)
    return false

  if (set.length > 1)
    return true

  for (var j = 0; j < set[0].length; j++) {
    if (typeof set[0][j] !== 'string')
      return true
  }

  return false
}

glob.Glob = Glob
inherits(Glob, EE)
function Glob (pattern, options, cb) {
  if (typeof options === 'function') {
    cb = options
    options = null
  }

  if (options && options.sync) {
    if (cb)
      throw new TypeError('callback provided to sync glob')
    return new GlobSync(pattern, options)
  }

  if (!(this instanceof Glob))
    return new Glob(pattern, options, cb)

  setopts(this, pattern, options)
  this._didRealPath = false

  // process each pattern in the minimatch set
  var n = this.minimatch.set.length

  // The matches are stored as {<filename>: true,...} so that
  // duplicates are automagically pruned.
  // Later, we do an Object.keys() on these.
  // Keep them as a list so we can fill in when nonull is set.
  this.matches = new Array(n)

  if (typeof cb === 'function') {
    cb = once(cb)
    this.on('error', cb)
    this.on('end', function (matches) {
      cb(null, matches)
    })
  }

  var self = this
  this._processing = 0

  this._emitQueue = []
  this._processQueue = []
  this.paused = false

  if (this.noprocess)
    return this

  if (n === 0)
    return done()

  var sync = true
  for (var i = 0; i < n; i ++) {
    this._process(this.minimatch.set[i], i, false, done)
  }
  sync = false

  function done () {
    --self._processing
    if (self._processing <= 0) {
      if (sync) {
        process.nextTick(function () {
          self._finish()
        })
      } else {
        self._finish()
      }
    }
  }
}

Glob.prototype._finish = function () {
  assert(this instanceof Glob)
  if (this.aborted)
    return

  if (this.realpath && !this._didRealpath)
    return this._realpath()

  common.finish(this)
  this.emit('end', this.found)
}

Glob.prototype._realpath = function () {
  if (this._didRealpath)
    return

  this._didRealpath = true

  var n = this.matches.length
  if (n === 0)
    return this._finish()

  var self = this
  for (var i = 0; i < this.matches.length; i++)
    this._realpathSet(i, next)

  function next () {
    if (--n === 0)
      self._finish()
  }
}

Glob.prototype._realpathSet = function (index, cb) {
  var matchset = this.matches[index]
  if (!matchset)
    return cb()

  var found = Object.keys(matchset)
  var self = this
  var n = found.length

  if (n === 0)
    return cb()

  var set = this.matches[index] = Object.create(null)
  found.forEach(function (p, i) {
    // If there's a problem with the stat, then it means that
    // one or more of the links in the realpath couldn't be
    // resolved.  just return the abs value in that case.
    p = self._makeAbs(p)
    rp.realpath(p, self.realpathCache, function (er, real) {
      if (!er)
        set[real] = true
      else if (er.syscall === 'stat')
        set[p] = true
      else
        self.emit('error', er) // srsly wtf right here

      if (--n === 0) {
        self.matches[index] = set
        cb()
      }
    })
  })
}

Glob.prototype._mark = function (p) {
  return common.mark(this, p)
}

Glob.prototype._makeAbs = function (f) {
  return common.makeAbs(this, f)
}

Glob.prototype.abort = function () {
  this.aborted = true
  this.emit('abort')
}

Glob.prototype.pause = function () {
  if (!this.paused) {
    this.paused = true
    this.emit('pause')
  }
}

Glob.prototype.resume = function () {
  if (this.paused) {
    this.emit('resume')
    this.paused = false
    if (this._emitQueue.length) {
      var eq = this._emitQueue.slice(0)
      this._emitQueue.length = 0
      for (var i = 0; i < eq.length; i ++) {
        var e = eq[i]
        this._emitMatch(e[0], e[1])
      }
    }
    if (this._processQueue.length) {
      var pq = this._processQueue.slice(0)
      this._processQueue.length = 0
      for (var i = 0; i < pq.length; i ++) {
        var p = pq[i]
        this._processing--
        this._process(p[0], p[1], p[2], p[3])
      }
    }
  }
}

Glob.prototype._process = function (pattern, index, inGlobStar, cb) {
  assert(this instanceof Glob)
  assert(typeof cb === 'function')

  if (this.aborted)
    return

  this._processing++
  if (this.paused) {
    this._processQueue.push([pattern, index, inGlobStar, cb])
    return
  }

  //console.error('PROCESS %d', this._processing, pattern)

  // Get the first [n] parts of pattern that are all strings.
  var n = 0
  while (typeof pattern[n] === 'string') {
    n ++
  }
  // now n is the index of the first one that is *not* a string.

  // see if there's anything else
  var prefix
  switch (n) {
    // if not, then this is rather simple
    case pattern.length:
      this._processSimple(pattern.join('/'), index, cb)
      return

    case 0:
      // pattern *starts* with some non-trivial item.
      // going to readdir(cwd), but not include the prefix in matches.
      prefix = null
      break

    default:
      // pattern has some string bits in the front.
      // whatever it starts with, whether that's 'absolute' like /foo/bar,
      // or 'relative' like '../baz'
      prefix = pattern.slice(0, n).join('/')
      break
  }

  var remain = pattern.slice(n)

  // get the list of entries.
  var read
  if (prefix === null)
    read = '.'
  else if (isAbsolute(prefix) || isAbsolute(pattern.join('/'))) {
    if (!prefix || !isAbsolute(prefix))
      prefix = '/' + prefix
    read = prefix
  } else
    read = prefix

  var abs = this._makeAbs(read)

  //if ignored, skip _processing
  if (childrenIgnored(this, read))
    return cb()

  var isGlobStar = remain[0] === minimatch.GLOBSTAR
  if (isGlobStar)
    this._processGlobStar(prefix, read, abs, remain, index, inGlobStar, cb)
  else
    this._processReaddir(prefix, read, abs, remain, index, inGlobStar, cb)
}

Glob.prototype._processReaddir = function (prefix, read, abs, remain, index, inGlobStar, cb) {
  var self = this
  this._readdir(abs, inGlobStar, function (er, entries) {
    return self._processReaddir2(prefix, read, abs, remain, index, inGlobStar, entries, cb)
  })
}

Glob.prototype._processReaddir2 = function (prefix, read, abs, remain, index, inGlobStar, entries, cb) {

  // if the abs isn't a dir, then nothing can match!
  if (!entries)
    return cb()

  // It will only match dot entries if it starts with a dot, or if
  // dot is set.  Stuff like @(.foo|.bar) isn't allowed.
  var pn = remain[0]
  var negate = !!this.minimatch.negate
  var rawGlob = pn._glob
  var dotOk = this.dot || rawGlob.charAt(0) === '.'

  var matchedEntries = []
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i]
    if (e.charAt(0) !== '.' || dotOk) {
      var m
      if (negate && !prefix) {
        m = !e.match(pn)
      } else {
        m = e.match(pn)
      }
      if (m)
        matchedEntries.push(e)
    }
  }

  //console.error('prd2', prefix, entries, remain[0]._glob, matchedEntries)

  var len = matchedEntries.length
  // If there are no matched entries, then nothing matches.
  if (len === 0)
    return cb()

  // if this is the last remaining pattern bit, then no need for
  // an additional stat *unless* the user has specified mark or
  // stat explicitly.  We know they exist, since readdir returned
  // them.

  if (remain.length === 1 && !this.mark && !this.stat) {
    if (!this.matches[index])
      this.matches[index] = Object.create(null)

    for (var i = 0; i < len; i ++) {
      var e = matchedEntries[i]
      if (prefix) {
        if (prefix !== '/')
          e = prefix + '/' + e
        else
          e = prefix + e
      }

      if (e.charAt(0) === '/' && !this.nomount) {
        e = path.join(this.root, e)
      }
      this._emitMatch(index, e)
    }
    // This was the last one, and no stats were needed
    return cb()
  }

  // now test all matched entries as stand-ins for that part
  // of the pattern.
  remain.shift()
  for (var i = 0; i < len; i ++) {
    var e = matchedEntries[i]
    var newPattern
    if (prefix) {
      if (prefix !== '/')
        e = prefix + '/' + e
      else
        e = prefix + e
    }
    this._process([e].concat(remain), index, inGlobStar, cb)
  }
  cb()
}

Glob.prototype._emitMatch = function (index, e) {
  if (this.aborted)
    return

  if (isIgnored(this, e))
    return

  if (this.paused) {
    this._emitQueue.push([index, e])
    return
  }

  var abs = isAbsolute(e) ? e : this._makeAbs(e)

  if (this.mark)
    e = this._mark(e)

  if (this.absolute)
    e = abs

  if (this.matches[index][e])
    return

  if (this.nodir) {
    var c = this.cache[abs]
    if (c === 'DIR' || Array.isArray(c))
      return
  }

  this.matches[index][e] = true

  var st = this.statCache[abs]
  if (st)
    this.emit('stat', e, st)

  this.emit('match', e)
}

Glob.prototype._readdirInGlobStar = function (abs, cb) {
  if (this.aborted)
    return

  // follow all symlinked directories forever
  // just proceed as if this is a non-globstar situation
  if (this.follow)
    return this._readdir(abs, false, cb)

  var lstatkey = 'lstat\0' + abs
  var self = this
  var lstatcb = inflight(lstatkey, lstatcb_)

  if (lstatcb)
    self.fs.lstat(abs, lstatcb)

  function lstatcb_ (er, lstat) {
    if (er && er.code === 'ENOENT')
      return cb()

    var isSym = lstat && lstat.isSymbolicLink()
    self.symlinks[abs] = isSym

    // If it's not a symlink or a dir, then it's definitely a regular file.
    // don't bother doing a readdir in that case.
    if (!isSym && lstat && !lstat.isDirectory()) {
      self.cache[abs] = 'FILE'
      cb()
    } else
      self._readdir(abs, false, cb)
  }
}

Glob.prototype._readdir = function (abs, inGlobStar, cb) {
  if (this.aborted)
    return

  cb = inflight('readdir\0'+abs+'\0'+inGlobStar, cb)
  if (!cb)
    return

  //console.error('RD %j %j', +inGlobStar, abs)
  if (inGlobStar && !ownProp(this.symlinks, abs))
    return this._readdirInGlobStar(abs, cb)

  if (ownProp(this.cache, abs)) {
    var c = this.cache[abs]
    if (!c || c === 'FILE')
      return cb()

    if (Array.isArray(c))
      return cb(null, c)
  }

  var self = this
  self.fs.readdir(abs, readdirCb(this, abs, cb))
}

function readdirCb (self, abs, cb) {
  return function (er, entries) {
    if (er)
      self._readdirError(abs, er, cb)
    else
      self._readdirEntries(abs, entries, cb)
  }
}

Glob.prototype._readdirEntries = function (abs, entries, cb) {
  if (this.aborted)
    return

  // if we haven't asked to stat everything, then just
  // assume that everything in there exists, so we can avoid
  // having to stat it a second time.
  if (!this.mark && !this.stat) {
    for (var i = 0; i < entries.length; i ++) {
      var e = entries[i]
      if (abs === '/')
        e = abs + e
      else
        e = abs + '/' + e
      this.cache[e] = true
    }
  }

  this.cache[abs] = entries
  return cb(null, entries)
}

Glob.prototype._readdirError = function (f, er, cb) {
  if (this.aborted)
    return

  // handle errors, and cache the information
  switch (er.code) {
    case 'ENOTSUP': // https://github.com/isaacs/node-glob/issues/205
    case 'ENOTDIR': // totally normal. means it *does* exist.
      var abs = this._makeAbs(f)
      this.cache[abs] = 'FILE'
      if (abs === this.cwdAbs) {
        var error = new Error(er.code + ' invalid cwd ' + this.cwd)
        error.path = this.cwd
        error.code = er.code
        this.emit('error', error)
        this.abort()
      }
      break

    case 'ENOENT': // not terribly unusual
    case 'ELOOP':
    case 'ENAMETOOLONG':
    case 'UNKNOWN':
      this.cache[this._makeAbs(f)] = false
      break

    default: // some unusual error.  Treat as failure.
      this.cache[this._makeAbs(f)] = false
      if (this.strict) {
        this.emit('error', er)
        // If the error is handled, then we abort
        // if not, we threw out of here
        this.abort()
      }
      if (!this.silent)
        console.error('glob error', er)
      break
  }

  return cb()
}

Glob.prototype._processGlobStar = function (prefix, read, abs, remain, index, inGlobStar, cb) {
  var self = this
  this._readdir(abs, inGlobStar, function (er, entries) {
    self._processGlobStar2(prefix, read, abs, remain, index, inGlobStar, entries, cb)
  })
}


Glob.prototype._processGlobStar2 = function (prefix, read, abs, remain, index, inGlobStar, entries, cb) {
  //console.error('pgs2', prefix, remain[0], entries)

  // no entries means not a dir, so it can never have matches
  // foo.txt/** doesn't match foo.txt
  if (!entries)
    return cb()

  // test without the globstar, and with every child both below
  // and replacing the globstar.
  var remainWithoutGlobStar = remain.slice(1)
  var gspref = prefix ? [ prefix ] : []
  var noGlobStar = gspref.concat(remainWithoutGlobStar)

  // the noGlobStar pattern exits the inGlobStar state
  this._process(noGlobStar, index, false, cb)

  var isSym = this.symlinks[abs]
  var len = entries.length

  // If it's a symlink, and we're in a globstar, then stop
  if (isSym && inGlobStar)
    return cb()

  for (var i = 0; i < len; i++) {
    var e = entries[i]
    if (e.charAt(0) === '.' && !this.dot)
      continue

    // these two cases enter the inGlobStar state
    var instead = gspref.concat(entries[i], remainWithoutGlobStar)
    this._process(instead, index, true, cb)

    var below = gspref.concat(entries[i], remain)
    this._process(below, index, true, cb)
  }

  cb()
}

Glob.prototype._processSimple = function (prefix, index, cb) {
  // XXX review this.  Shouldn't it be doing the mounting etc
  // before doing stat?  kinda weird?
  var self = this
  this._stat(prefix, function (er, exists) {
    self._processSimple2(prefix, index, er, exists, cb)
  })
}
Glob.prototype._processSimple2 = function (prefix, index, er, exists, cb) {

  //console.error('ps2', prefix, exists)

  if (!this.matches[index])
    this.matches[index] = Object.create(null)

  // If it doesn't exist, then just mark the lack of results
  if (!exists)
    return cb()

  if (prefix && isAbsolute(prefix) && !this.nomount) {
    var trail = /[\/\\]$/.test(prefix)
    if (prefix.charAt(0) === '/') {
      prefix = path.join(this.root, prefix)
    } else {
      prefix = path.resolve(this.root, prefix)
      if (trail)
        prefix += '/'
    }
  }

  if (process.platform === 'win32')
    prefix = prefix.replace(/\\/g, '/')

  // Mark this as a match
  this._emitMatch(index, prefix)
  cb()
}

// Returns either 'DIR', 'FILE', or false
Glob.prototype._stat = function (f, cb) {
  var abs = this._makeAbs(f)
  var needDir = f.slice(-1) === '/'

  if (f.length > this.maxLength)
    return cb()

  if (!this.stat && ownProp(this.cache, abs)) {
    var c = this.cache[abs]

    if (Array.isArray(c))
      c = 'DIR'

    // It exists, but maybe not how we need it
    if (!needDir || c === 'DIR')
      return cb(null, c)

    if (needDir && c === 'FILE')
      return cb()

    // otherwise we have to stat, because maybe c=true
    // if we know it exists, but not what it is.
  }

  var exists
  var stat = this.statCache[abs]
  if (stat !== undefined) {
    if (stat === false)
      return cb(null, stat)
    else {
      var type = stat.isDirectory() ? 'DIR' : 'FILE'
      if (needDir && type === 'FILE')
        return cb()
      else
        return cb(null, type, stat)
    }
  }

  var self = this
  var statcb = inflight('stat\0' + abs, lstatcb_)
  if (statcb)
    self.fs.lstat(abs, statcb)

  function lstatcb_ (er, lstat) {
    if (lstat && lstat.isSymbolicLink()) {
      // If it's a symlink, then treat it as the target, unless
      // the target does not exist, then treat it as a file.
      return self.fs.stat(abs, function (er, stat) {
        if (er)
          self._stat2(f, abs, null, lstat, cb)
        else
          self._stat2(f, abs, er, stat, cb)
      })
    } else {
      self._stat2(f, abs, er, lstat, cb)
    }
  }
}

Glob.prototype._stat2 = function (f, abs, er, stat, cb) {
  if (er && (er.code === 'ENOENT' || er.code === 'ENOTDIR')) {
    this.statCache[abs] = false
    return cb()
  }

  var needDir = f.slice(-1) === '/'
  this.statCache[abs] = stat

  if (abs.slice(-1) === '/' && stat && !stat.isDirectory())
    return cb(null, false, stat)

  var c = true
  if (stat)
    c = stat.isDirectory() ? 'DIR' : 'FILE'
  this.cache[abs] = this.cache[abs] || c

  if (needDir && c === 'FILE')
    return cb()

  return cb(null, c, stat)
}


/***/ }),

/***/ 9010:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

module.exports = globSync
globSync.GlobSync = GlobSync

var rp = __nccwpck_require__(6863)
var minimatch = __nccwpck_require__(3973)
var Minimatch = minimatch.Minimatch
var Glob = (__nccwpck_require__(1957).Glob)
var util = __nccwpck_require__(3837)
var path = __nccwpck_require__(1017)
var assert = __nccwpck_require__(9491)
var isAbsolute = __nccwpck_require__(8714)
var common = __nccwpck_require__(7625)
var setopts = common.setopts
var ownProp = common.ownProp
var childrenIgnored = common.childrenIgnored
var isIgnored = common.isIgnored

function globSync (pattern, options) {
  if (typeof options === 'function' || arguments.length === 3)
    throw new TypeError('callback provided to sync glob\n'+
                        'See: https://github.com/isaacs/node-glob/issues/167')

  return new GlobSync(pattern, options).found
}

function GlobSync (pattern, options) {
  if (!pattern)
    throw new Error('must provide pattern')

  if (typeof options === 'function' || arguments.length === 3)
    throw new TypeError('callback provided to sync glob\n'+
                        'See: https://github.com/isaacs/node-glob/issues/167')

  if (!(this instanceof GlobSync))
    return new GlobSync(pattern, options)

  setopts(this, pattern, options)

  if (this.noprocess)
    return this

  var n = this.minimatch.set.length
  this.matches = new Array(n)
  for (var i = 0; i < n; i ++) {
    this._process(this.minimatch.set[i], i, false)
  }
  this._finish()
}

GlobSync.prototype._finish = function () {
  assert(this instanceof GlobSync)
  if (this.realpath) {
    var self = this
    this.matches.forEach(function (matchset, index) {
      var set = self.matches[index] = Object.create(null)
      for (var p in matchset) {
        try {
          p = self._makeAbs(p)
          var real = rp.realpathSync(p, self.realpathCache)
          set[real] = true
        } catch (er) {
          if (er.syscall === 'stat')
            set[self._makeAbs(p)] = true
          else
            throw er
        }
      }
    })
  }
  common.finish(this)
}


GlobSync.prototype._process = function (pattern, index, inGlobStar) {
  assert(this instanceof GlobSync)

  // Get the first [n] parts of pattern that are all strings.
  var n = 0
  while (typeof pattern[n] === 'string') {
    n ++
  }
  // now n is the index of the first one that is *not* a string.

  // See if there's anything else
  var prefix
  switch (n) {
    // if not, then this is rather simple
    case pattern.length:
      this._processSimple(pattern.join('/'), index)
      return

    case 0:
      // pattern *starts* with some non-trivial item.
      // going to readdir(cwd), but not include the prefix in matches.
      prefix = null
      break

    default:
      // pattern has some string bits in the front.
      // whatever it starts with, whether that's 'absolute' like /foo/bar,
      // or 'relative' like '../baz'
      prefix = pattern.slice(0, n).join('/')
      break
  }

  var remain = pattern.slice(n)

  // get the list of entries.
  var read
  if (prefix === null)
    read = '.'
  else if (isAbsolute(prefix) || isAbsolute(pattern.join('/'))) {
    if (!prefix || !isAbsolute(prefix))
      prefix = '/' + prefix
    read = prefix
  } else
    read = prefix

  var abs = this._makeAbs(read)

  //if ignored, skip processing
  if (childrenIgnored(this, read))
    return

  var isGlobStar = remain[0] === minimatch.GLOBSTAR
  if (isGlobStar)
    this._processGlobStar(prefix, read, abs, remain, index, inGlobStar)
  else
    this._processReaddir(prefix, read, abs, remain, index, inGlobStar)
}


GlobSync.prototype._processReaddir = function (prefix, read, abs, remain, index, inGlobStar) {
  var entries = this._readdir(abs, inGlobStar)

  // if the abs isn't a dir, then nothing can match!
  if (!entries)
    return

  // It will only match dot entries if it starts with a dot, or if
  // dot is set.  Stuff like @(.foo|.bar) isn't allowed.
  var pn = remain[0]
  var negate = !!this.minimatch.negate
  var rawGlob = pn._glob
  var dotOk = this.dot || rawGlob.charAt(0) === '.'

  var matchedEntries = []
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i]
    if (e.charAt(0) !== '.' || dotOk) {
      var m
      if (negate && !prefix) {
        m = !e.match(pn)
      } else {
        m = e.match(pn)
      }
      if (m)
        matchedEntries.push(e)
    }
  }

  var len = matchedEntries.length
  // If there are no matched entries, then nothing matches.
  if (len === 0)
    return

  // if this is the last remaining pattern bit, then no need for
  // an additional stat *unless* the user has specified mark or
  // stat explicitly.  We know they exist, since readdir returned
  // them.

  if (remain.length === 1 && !this.mark && !this.stat) {
    if (!this.matches[index])
      this.matches[index] = Object.create(null)

    for (var i = 0; i < len; i ++) {
      var e = matchedEntries[i]
      if (prefix) {
        if (prefix.slice(-1) !== '/')
          e = prefix + '/' + e
        else
          e = prefix + e
      }

      if (e.charAt(0) === '/' && !this.nomount) {
        e = path.join(this.root, e)
      }
      this._emitMatch(index, e)
    }
    // This was the last one, and no stats were needed
    return
  }

  // now test all matched entries as stand-ins for that part
  // of the pattern.
  remain.shift()
  for (var i = 0; i < len; i ++) {
    var e = matchedEntries[i]
    var newPattern
    if (prefix)
      newPattern = [prefix, e]
    else
      newPattern = [e]
    this._process(newPattern.concat(remain), index, inGlobStar)
  }
}


GlobSync.prototype._emitMatch = function (index, e) {
  if (isIgnored(this, e))
    return

  var abs = this._makeAbs(e)

  if (this.mark)
    e = this._mark(e)

  if (this.absolute) {
    e = abs
  }

  if (this.matches[index][e])
    return

  if (this.nodir) {
    var c = this.cache[abs]
    if (c === 'DIR' || Array.isArray(c))
      return
  }

  this.matches[index][e] = true

  if (this.stat)
    this._stat(e)
}


GlobSync.prototype._readdirInGlobStar = function (abs) {
  // follow all symlinked directories forever
  // just proceed as if this is a non-globstar situation
  if (this.follow)
    return this._readdir(abs, false)

  var entries
  var lstat
  var stat
  try {
    lstat = this.fs.lstatSync(abs)
  } catch (er) {
    if (er.code === 'ENOENT') {
      // lstat failed, doesn't exist
      return null
    }
  }

  var isSym = lstat && lstat.isSymbolicLink()
  this.symlinks[abs] = isSym

  // If it's not a symlink or a dir, then it's definitely a regular file.
  // don't bother doing a readdir in that case.
  if (!isSym && lstat && !lstat.isDirectory())
    this.cache[abs] = 'FILE'
  else
    entries = this._readdir(abs, false)

  return entries
}

GlobSync.prototype._readdir = function (abs, inGlobStar) {
  var entries

  if (inGlobStar && !ownProp(this.symlinks, abs))
    return this._readdirInGlobStar(abs)

  if (ownProp(this.cache, abs)) {
    var c = this.cache[abs]
    if (!c || c === 'FILE')
      return null

    if (Array.isArray(c))
      return c
  }

  try {
    return this._readdirEntries(abs, this.fs.readdirSync(abs))
  } catch (er) {
    this._readdirError(abs, er)
    return null
  }
}

GlobSync.prototype._readdirEntries = function (abs, entries) {
  // if we haven't asked to stat everything, then just
  // assume that everything in there exists, so we can avoid
  // having to stat it a second time.
  if (!this.mark && !this.stat) {
    for (var i = 0; i < entries.length; i ++) {
      var e = entries[i]
      if (abs === '/')
        e = abs + e
      else
        e = abs + '/' + e
      this.cache[e] = true
    }
  }

  this.cache[abs] = entries

  // mark and cache dir-ness
  return entries
}

GlobSync.prototype._readdirError = function (f, er) {
  // handle errors, and cache the information
  switch (er.code) {
    case 'ENOTSUP': // https://github.com/isaacs/node-glob/issues/205
    case 'ENOTDIR': // totally normal. means it *does* exist.
      var abs = this._makeAbs(f)
      this.cache[abs] = 'FILE'
      if (abs === this.cwdAbs) {
        var error = new Error(er.code + ' invalid cwd ' + this.cwd)
        error.path = this.cwd
        error.code = er.code
        throw error
      }
      break

    case 'ENOENT': // not terribly unusual
    case 'ELOOP':
    case 'ENAMETOOLONG':
    case 'UNKNOWN':
      this.cache[this._makeAbs(f)] = false
      break

    default: // some unusual error.  Treat as failure.
      this.cache[this._makeAbs(f)] = false
      if (this.strict)
        throw er
      if (!this.silent)
        console.error('glob error', er)
      break
  }
}

GlobSync.prototype._processGlobStar = function (prefix, read, abs, remain, index, inGlobStar) {

  var entries = this._readdir(abs, inGlobStar)

  // no entries means not a dir, so it can never have matches
  // foo.txt/** doesn't match foo.txt
  if (!entries)
    return

  // test without the globstar, and with every child both below
  // and replacing the globstar.
  var remainWithoutGlobStar = remain.slice(1)
  var gspref = prefix ? [ prefix ] : []
  var noGlobStar = gspref.concat(remainWithoutGlobStar)

  // the noGlobStar pattern exits the inGlobStar state
  this._process(noGlobStar, index, false)

  var len = entries.length
  var isSym = this.symlinks[abs]

  // If it's a symlink, and we're in a globstar, then stop
  if (isSym && inGlobStar)
    return

  for (var i = 0; i < len; i++) {
    var e = entries[i]
    if (e.charAt(0) === '.' && !this.dot)
      continue

    // these two cases enter the inGlobStar state
    var instead = gspref.concat(entries[i], remainWithoutGlobStar)
    this._process(instead, index, true)

    var below = gspref.concat(entries[i], remain)
    this._process(below, index, true)
  }
}

GlobSync.prototype._processSimple = function (prefix, index) {
  // XXX review this.  Shouldn't it be doing the mounting etc
  // before doing stat?  kinda weird?
  var exists = this._stat(prefix)

  if (!this.matches[index])
    this.matches[index] = Object.create(null)

  // If it doesn't exist, then just mark the lack of results
  if (!exists)
    return

  if (prefix && isAbsolute(prefix) && !this.nomount) {
    var trail = /[\/\\]$/.test(prefix)
    if (prefix.charAt(0) === '/') {
      prefix = path.join(this.root, prefix)
    } else {
      prefix = path.resolve(this.root, prefix)
      if (trail)
        prefix += '/'
    }
  }

  if (process.platform === 'win32')
    prefix = prefix.replace(/\\/g, '/')

  // Mark this as a match
  this._emitMatch(index, prefix)
}

// Returns either 'DIR', 'FILE', or false
GlobSync.prototype._stat = function (f) {
  var abs = this._makeAbs(f)
  var needDir = f.slice(-1) === '/'

  if (f.length > this.maxLength)
    return false

  if (!this.stat && ownProp(this.cache, abs)) {
    var c = this.cache[abs]

    if (Array.isArray(c))
      c = 'DIR'

    // It exists, but maybe not how we need it
    if (!needDir || c === 'DIR')
      return c

    if (needDir && c === 'FILE')
      return false

    // otherwise we have to stat, because maybe c=true
    // if we know it exists, but not what it is.
  }

  var exists
  var stat = this.statCache[abs]
  if (!stat) {
    var lstat
    try {
      lstat = this.fs.lstatSync(abs)
    } catch (er) {
      if (er && (er.code === 'ENOENT' || er.code === 'ENOTDIR')) {
        this.statCache[abs] = false
        return false
      }
    }

    if (lstat && lstat.isSymbolicLink()) {
      try {
        stat = this.fs.statSync(abs)
      } catch (er) {
        stat = lstat
      }
    } else {
      stat = lstat
    }
  }

  this.statCache[abs] = stat

  var c = true
  if (stat)
    c = stat.isDirectory() ? 'DIR' : 'FILE'

  this.cache[abs] = this.cache[abs] || c

  if (needDir && c === 'FILE')
    return false

  return c
}

GlobSync.prototype._mark = function (p) {
  return common.mark(this, p)
}

GlobSync.prototype._makeAbs = function (f) {
  return common.makeAbs(this, f)
}


/***/ }),

/***/ 9038:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {


const fs = __nccwpck_require__(7147);
const path = __nccwpck_require__(1017);
const fastGlob = __nccwpck_require__(2147);
const gitIgnore = __nccwpck_require__(1230);
const pify = __nccwpck_require__(4810);
const slash = __nccwpck_require__(7543);

const DEFAULT_IGNORE = [
	'**/node_modules/**',
	'**/bower_components/**',
	'**/flow-typed/**',
	'**/coverage/**',
	'**/.git'
];

const readFileP = pify(fs.readFile);

const mapGitIgnorePatternTo = base => ignore => {
	if (ignore.startsWith('!')) {
		return '!' + path.posix.join(base, ignore.slice(1));
	}

	return path.posix.join(base, ignore);
};

const parseGitIgnore = (content, options) => {
	const base = slash(path.relative(options.cwd, path.dirname(options.fileName)));

	return content
		.split(/\r?\n/)
		.filter(Boolean)
		.filter(line => line.charAt(0) !== '#')
		.map(mapGitIgnorePatternTo(base));
};

const reduceIgnore = files => {
	return files.reduce((ignores, file) => {
		ignores.add(parseGitIgnore(file.content, {
			cwd: file.cwd,
			fileName: file.filePath
		}));
		return ignores;
	}, gitIgnore());
};

const getIsIgnoredPredecate = (ignores, cwd) => {
	return p => ignores.ignores(slash(path.relative(cwd, p)));
};

const getFile = (file, cwd) => {
	const filePath = path.join(cwd, file);
	return readFileP(filePath, 'utf8')
		.then(content => ({
			content,
			cwd,
			filePath
		}));
};

const getFileSync = (file, cwd) => {
	const filePath = path.join(cwd, file);
	const content = fs.readFileSync(filePath, 'utf8');

	return {
		content,
		cwd,
		filePath
	};
};

const normalizeOptions = (options = {}) => {
	const ignore = options.ignore || [];
	const cwd = options.cwd || process.cwd();
	return {ignore, cwd};
};

module.exports = options => {
	options = normalizeOptions(options);

	return fastGlob('**/.gitignore', {
		ignore: DEFAULT_IGNORE.concat(options.ignore),
		cwd: options.cwd
	})
		.then(paths => Promise.all(paths.map(file => getFile(file, options.cwd))))
		.then(files => reduceIgnore(files))
		.then(ignores => getIsIgnoredPredecate(ignores, options.cwd));
};

module.exports.sync = options => {
	options = normalizeOptions(options);

	const paths = fastGlob.sync('**/.gitignore', {
		ignore: DEFAULT_IGNORE.concat(options.ignore),
		cwd: options.cwd
	});
	const files = paths.map(file => getFileSync(file, options.cwd));
	const ignores = reduceIgnore(files);

	return getIsIgnoredPredecate(ignores, options.cwd);
};


/***/ }),

/***/ 3398:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {


const fs = __nccwpck_require__(7147);
const arrayUnion = __nccwpck_require__(9600);
const glob = __nccwpck_require__(1957);
const fastGlob = __nccwpck_require__(2147);
const dirGlob = __nccwpck_require__(2738);
const gitignore = __nccwpck_require__(9038);

const DEFAULT_FILTER = () => false;

const isNegative = pattern => pattern[0] === '!';

const assertPatternsInput = patterns => {
	if (!patterns.every(x => typeof x === 'string')) {
		throw new TypeError('Patterns must be a string or an array of strings');
	}
};

const checkCwdOption = options => {
	if (options && options.cwd && !fs.statSync(options.cwd).isDirectory()) {
		throw new Error('The `cwd` option must be a path to a directory');
	}
};

const generateGlobTasks = (patterns, taskOptions) => {
	patterns = arrayUnion([].concat(patterns));
	assertPatternsInput(patterns);
	checkCwdOption(taskOptions);

	const globTasks = [];

	taskOptions = Object.assign({
		ignore: [],
		expandDirectories: true
	}, taskOptions);

	patterns.forEach((pattern, i) => {
		if (isNegative(pattern)) {
			return;
		}

		const ignore = patterns
			.slice(i)
			.filter(isNegative)
			.map(pattern => pattern.slice(1));

		const options = Object.assign({}, taskOptions, {
			ignore: taskOptions.ignore.concat(ignore)
		});

		globTasks.push({pattern, options});
	});

	return globTasks;
};

const globDirs = (task, fn) => {
	let options = {};
	if (task.options.cwd) {
		options.cwd = task.options.cwd;
	}

	if (Array.isArray(task.options.expandDirectories)) {
		options = Object.assign(options, {files: task.options.expandDirectories});
	} else if (typeof task.options.expandDirectories === 'object') {
		options = Object.assign(options, task.options.expandDirectories);
	}

	return fn(task.pattern, options);
};

const getPattern = (task, fn) => task.options.expandDirectories ? globDirs(task, fn) : [task.pattern];

const globToTask = task => glob => {
	const {options} = task;
	if (options.ignore && Array.isArray(options.ignore) && options.expandDirectories) {
		options.ignore = dirGlob.sync(options.ignore);
	}

	return {
		pattern: glob,
		options
	};
};

const globby = (patterns, options) => {
	let globTasks;

	try {
		globTasks = generateGlobTasks(patterns, options);
	} catch (error) {
		return Promise.reject(error);
	}

	const getTasks = Promise.all(globTasks.map(task => Promise.resolve(getPattern(task, dirGlob))
		.then(globs => Promise.all(globs.map(globToTask(task))))
	))
		.then(tasks => arrayUnion(...tasks));

	const getFilter = () => {
		return Promise.resolve(
			options && options.gitignore ?
				gitignore({cwd: options.cwd, ignore: options.ignore}) :
				DEFAULT_FILTER
		);
	};

	return getFilter()
		.then(filter => {
			return getTasks
				.then(tasks => Promise.all(tasks.map(task => fastGlob(task.pattern, task.options))))
				.then(paths => arrayUnion(...paths))
				.then(paths => paths.filter(p => !filter(p)));
		});
};

module.exports = globby;
// TODO: Remove this for the next major release
module.exports["default"] = globby;

module.exports.sync = (patterns, options) => {
	const globTasks = generateGlobTasks(patterns, options);

	const getFilter = () => {
		return options && options.gitignore ?
			gitignore.sync({cwd: options.cwd, ignore: options.ignore}) :
			DEFAULT_FILTER;
	};

	const tasks = globTasks.reduce((tasks, task) => {
		const newTask = getPattern(task, dirGlob.sync).map(globToTask(task));
		return tasks.concat(newTask);
	}, []);

	const filter = getFilter();
	return tasks.reduce(
		(matches, task) => arrayUnion(matches, fastGlob.sync(task.pattern, task.options)),
		[]
	).filter(p => !filter(p));
};

module.exports.generateGlobTasks = generateGlobTasks;

module.exports.hasMagic = (patterns, options) => []
	.concat(patterns)
	.some(pattern => glob.hasMagic(pattern, options));

module.exports.gitignore = gitignore;


/***/ }),

/***/ 7356:
/***/ ((module) => {



module.exports = clone

var getPrototypeOf = Object.getPrototypeOf || function (obj) {
  return obj.__proto__
}

function clone (obj) {
  if (obj === null || typeof obj !== 'object')
    return obj

  if (obj instanceof Object)
    var copy = { __proto__: getPrototypeOf(obj) }
  else
    var copy = Object.create(null)

  Object.getOwnPropertyNames(obj).forEach(function (key) {
    Object.defineProperty(copy, key, Object.getOwnPropertyDescriptor(obj, key))
  })

  return copy
}


/***/ }),

/***/ 7758:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

var fs = __nccwpck_require__(7147)
var polyfills = __nccwpck_require__(263)
var legacy = __nccwpck_require__(3086)
var clone = __nccwpck_require__(7356)

var util = __nccwpck_require__(3837)

/* istanbul ignore next - node 0.x polyfill */
var gracefulQueue
var previousSymbol

/* istanbul ignore else - node 0.x polyfill */
if (typeof Symbol === 'function' && typeof Symbol.for === 'function') {
  gracefulQueue = Symbol.for('graceful-fs.queue')
  // This is used in testing by future versions
  previousSymbol = Symbol.for('graceful-fs.previous')
} else {
  gracefulQueue = '___graceful-fs.queue'
  previousSymbol = '___graceful-fs.previous'
}

function noop () {}

function publishQueue(context, queue) {
  Object.defineProperty(context, gracefulQueue, {
    get: function() {
      return queue
    }
  })
}

var debug = noop
if (util.debuglog)
  debug = util.debuglog('gfs4')
else if (/\bgfs4\b/i.test(process.env.NODE_DEBUG || ''))
  debug = function() {
    var m = util.format.apply(util, arguments)
    m = 'GFS4: ' + m.split(/\n/).join('\nGFS4: ')
    console.error(m)
  }

// Once time initialization
if (!fs[gracefulQueue]) {
  // This queue can be shared by multiple loaded instances
  var queue = global[gracefulQueue] || []
  publishQueue(fs, queue)

  // Patch fs.close/closeSync to shared queue version, because we need
  // to retry() whenever a close happens *anywhere* in the program.
  // This is essential when multiple graceful-fs instances are
  // in play at the same time.
  fs.close = (function (fs$close) {
    function close (fd, cb) {
      return fs$close.call(fs, fd, function (err) {
        // This function uses the graceful-fs shared queue
        if (!err) {
          resetQueue()
        }

        if (typeof cb === 'function')
          cb.apply(this, arguments)
      })
    }

    Object.defineProperty(close, previousSymbol, {
      value: fs$close
    })
    return close
  })(fs.close)

  fs.closeSync = (function (fs$closeSync) {
    function closeSync (fd) {
      // This function uses the graceful-fs shared queue
      fs$closeSync.apply(fs, arguments)
      resetQueue()
    }

    Object.defineProperty(closeSync, previousSymbol, {
      value: fs$closeSync
    })
    return closeSync
  })(fs.closeSync)

  if (/\bgfs4\b/i.test(process.env.NODE_DEBUG || '')) {
    process.on('exit', function() {
      debug(fs[gracefulQueue])
      __nccwpck_require__(9491).equal(fs[gracefulQueue].length, 0)
    })
  }
}

if (!global[gracefulQueue]) {
  publishQueue(global, fs[gracefulQueue]);
}

module.exports = patch(clone(fs))
if (process.env.TEST_GRACEFUL_FS_GLOBAL_PATCH && !fs.__patched) {
    module.exports = patch(fs)
    fs.__patched = true;
}

function patch (fs) {
  // Everything that references the open() function needs to be in here
  polyfills(fs)
  fs.gracefulify = patch

  fs.createReadStream = createReadStream
  fs.createWriteStream = createWriteStream
  var fs$readFile = fs.readFile
  fs.readFile = readFile
  function readFile (path, options, cb) {
    if (typeof options === 'function')
      cb = options, options = null

    return go$readFile(path, options, cb)

    function go$readFile (path, options, cb, startTime) {
      return fs$readFile(path, options, function (err) {
        if (err && (err.code === 'EMFILE' || err.code === 'ENFILE'))
          enqueue([go$readFile, [path, options, cb], err, startTime || Date.now(), Date.now()])
        else {
          if (typeof cb === 'function')
            cb.apply(this, arguments)
        }
      })
    }
  }

  var fs$writeFile = fs.writeFile
  fs.writeFile = writeFile
  function writeFile (path, data, options, cb) {
    if (typeof options === 'function')
      cb = options, options = null

    return go$writeFile(path, data, options, cb)

    function go$writeFile (path, data, options, cb, startTime) {
      return fs$writeFile(path, data, options, function (err) {
        if (err && (err.code === 'EMFILE' || err.code === 'ENFILE'))
          enqueue([go$writeFile, [path, data, options, cb], err, startTime || Date.now(), Date.now()])
        else {
          if (typeof cb === 'function')
            cb.apply(this, arguments)
        }
      })
    }
  }

  var fs$appendFile = fs.appendFile
  if (fs$appendFile)
    fs.appendFile = appendFile
  function appendFile (path, data, options, cb) {
    if (typeof options === 'function')
      cb = options, options = null

    return go$appendFile(path, data, options, cb)

    function go$appendFile (path, data, options, cb, startTime) {
      return fs$appendFile(path, data, options, function (err) {
        if (err && (err.code === 'EMFILE' || err.code === 'ENFILE'))
          enqueue([go$appendFile, [path, data, options, cb], err, startTime || Date.now(), Date.now()])
        else {
          if (typeof cb === 'function')
            cb.apply(this, arguments)
        }
      })
    }
  }

  var fs$copyFile = fs.copyFile
  if (fs$copyFile)
    fs.copyFile = copyFile
  function copyFile (src, dest, flags, cb) {
    if (typeof flags === 'function') {
      cb = flags
      flags = 0
    }
    return go$copyFile(src, dest, flags, cb)

    function go$copyFile (src, dest, flags, cb, startTime) {
      return fs$copyFile(src, dest, flags, function (err) {
        if (err && (err.code === 'EMFILE' || err.code === 'ENFILE'))
          enqueue([go$copyFile, [src, dest, flags, cb], err, startTime || Date.now(), Date.now()])
        else {
          if (typeof cb === 'function')
            cb.apply(this, arguments)
        }
      })
    }
  }

  var fs$readdir = fs.readdir
  fs.readdir = readdir
  function readdir (path, options, cb) {
    if (typeof options === 'function')
      cb = options, options = null

    return go$readdir(path, options, cb)

    function go$readdir (path, options, cb, startTime) {
      return fs$readdir(path, options, function (err, files) {
        if (err && (err.code === 'EMFILE' || err.code === 'ENFILE'))
          enqueue([go$readdir, [path, options, cb], err, startTime || Date.now(), Date.now()])
        else {
          if (files && files.sort)
            files.sort()

          if (typeof cb === 'function')
            cb.call(this, err, files)
        }
      })
    }
  }

  if (process.version.substr(0, 4) === 'v0.8') {
    var legStreams = legacy(fs)
    ReadStream = legStreams.ReadStream
    WriteStream = legStreams.WriteStream
  }

  var fs$ReadStream = fs.ReadStream
  if (fs$ReadStream) {
    ReadStream.prototype = Object.create(fs$ReadStream.prototype)
    ReadStream.prototype.open = ReadStream$open
  }

  var fs$WriteStream = fs.WriteStream
  if (fs$WriteStream) {
    WriteStream.prototype = Object.create(fs$WriteStream.prototype)
    WriteStream.prototype.open = WriteStream$open
  }

  Object.defineProperty(fs, 'ReadStream', {
    get: function () {
      return ReadStream
    },
    set: function (val) {
      ReadStream = val
    },
    enumerable: true,
    configurable: true
  })
  Object.defineProperty(fs, 'WriteStream', {
    get: function () {
      return WriteStream
    },
    set: function (val) {
      WriteStream = val
    },
    enumerable: true,
    configurable: true
  })

  // legacy names
  var FileReadStream = ReadStream
  Object.defineProperty(fs, 'FileReadStream', {
    get: function () {
      return FileReadStream
    },
    set: function (val) {
      FileReadStream = val
    },
    enumerable: true,
    configurable: true
  })
  var FileWriteStream = WriteStream
  Object.defineProperty(fs, 'FileWriteStream', {
    get: function () {
      return FileWriteStream
    },
    set: function (val) {
      FileWriteStream = val
    },
    enumerable: true,
    configurable: true
  })

  function ReadStream (path, options) {
    if (this instanceof ReadStream)
      return fs$ReadStream.apply(this, arguments), this
    else
      return ReadStream.apply(Object.create(ReadStream.prototype), arguments)
  }

  function ReadStream$open () {
    var that = this
    open(that.path, that.flags, that.mode, function (err, fd) {
      if (err) {
        if (that.autoClose)
          that.destroy()

        that.emit('error', err)
      } else {
        that.fd = fd
        that.emit('open', fd)
        that.read()
      }
    })
  }

  function WriteStream (path, options) {
    if (this instanceof WriteStream)
      return fs$WriteStream.apply(this, arguments), this
    else
      return WriteStream.apply(Object.create(WriteStream.prototype), arguments)
  }

  function WriteStream$open () {
    var that = this
    open(that.path, that.flags, that.mode, function (err, fd) {
      if (err) {
        that.destroy()
        that.emit('error', err)
      } else {
        that.fd = fd
        that.emit('open', fd)
      }
    })
  }

  function createReadStream (path, options) {
    return new fs.ReadStream(path, options)
  }

  function createWriteStream (path, options) {
    return new fs.WriteStream(path, options)
  }

  var fs$open = fs.open
  fs.open = open
  function open (path, flags, mode, cb) {
    if (typeof mode === 'function')
      cb = mode, mode = null

    return go$open(path, flags, mode, cb)

    function go$open (path, flags, mode, cb, startTime) {
      return fs$open(path, flags, mode, function (err, fd) {
        if (err && (err.code === 'EMFILE' || err.code === 'ENFILE'))
          enqueue([go$open, [path, flags, mode, cb], err, startTime || Date.now(), Date.now()])
        else {
          if (typeof cb === 'function')
            cb.apply(this, arguments)
        }
      })
    }
  }

  return fs
}

function enqueue (elem) {
  debug('ENQUEUE', elem[0].name, elem[1])
  fs[gracefulQueue].push(elem)
  retry()
}

// keep track of the timeout between retry() calls
var retryTimer

// reset the startTime and lastTime to now
// this resets the start of the 60 second overall timeout as well as the
// delay between attempts so that we'll retry these jobs sooner
function resetQueue () {
  var now = Date.now()
  for (var i = 0; i < fs[gracefulQueue].length; ++i) {
    // entries that are only a length of 2 are from an older version, don't
    // bother modifying those since they'll be retried anyway.
    if (fs[gracefulQueue][i].length > 2) {
      fs[gracefulQueue][i][3] = now // startTime
      fs[gracefulQueue][i][4] = now // lastTime
    }
  }
  // call retry to make sure we're actively processing the queue
  retry()
}

function retry () {
  // clear the timer and remove it to help prevent unintended concurrency
  clearTimeout(retryTimer)
  retryTimer = undefined

  if (fs[gracefulQueue].length === 0)
    return

  var elem = fs[gracefulQueue].shift()
  var fn = elem[0]
  var args = elem[1]
  // these items may be unset if they were added by an older graceful-fs
  var err = elem[2]
  var startTime = elem[3]
  var lastTime = elem[4]

  // if we don't have a startTime we have no way of knowing if we've waited
  // long enough, so go ahead and retry this item now
  if (startTime === undefined) {
    debug('RETRY', fn.name, args)
    fn.apply(null, args)
  } else if (Date.now() - startTime >= 60000) {
    // it's been more than 60 seconds total, bail now
    debug('TIMEOUT', fn.name, args)
    var cb = args.pop()
    if (typeof cb === 'function')
      cb.call(null, err)
  } else {
    // the amount of time between the last attempt and right now
    var sinceAttempt = Date.now() - lastTime
    // the amount of time between when we first tried, and when we last tried
    // rounded up to at least 1
    var sinceStart = Math.max(lastTime - startTime, 1)
    // backoff. wait longer than the total time we've been retrying, but only
    // up to a maximum of 100ms
    var desiredDelay = Math.min(sinceStart * 1.2, 100)
    // it's been long enough since the last retry, do it again
    if (sinceAttempt >= desiredDelay) {
      debug('RETRY', fn.name, args)
      fn.apply(null, args.concat([startTime]))
    } else {
      // if we can't do this job yet, push it to the end of the queue
      // and let the next iteration check again
      fs[gracefulQueue].push(elem)
    }
  }

  // schedule our next run if one isn't already scheduled
  if (retryTimer === undefined) {
    retryTimer = setTimeout(retry, 0)
  }
}


/***/ }),

/***/ 3086:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

var Stream = (__nccwpck_require__(2781).Stream)

module.exports = legacy

function legacy (fs) {
  return {
    ReadStream: ReadStream,
    WriteStream: WriteStream
  }

  function ReadStream (path, options) {
    if (!(this instanceof ReadStream)) return new ReadStream(path, options);

    Stream.call(this);

    var self = this;

    this.path = path;
    this.fd = null;
    this.readable = true;
    this.paused = false;

    this.flags = 'r';
    this.mode = 438; /*=0666*/
    this.bufferSize = 64 * 1024;

    options = options || {};

    // Mixin options into this
    var keys = Object.keys(options);
    for (var index = 0, length = keys.length; index < length; index++) {
      var key = keys[index];
      this[key] = options[key];
    }

    if (this.encoding) this.setEncoding(this.encoding);

    if (this.start !== undefined) {
      if ('number' !== typeof this.start) {
        throw TypeError('start must be a Number');
      }
      if (this.end === undefined) {
        this.end = Infinity;
      } else if ('number' !== typeof this.end) {
        throw TypeError('end must be a Number');
      }

      if (this.start > this.end) {
        throw new Error('start must be <= end');
      }

      this.pos = this.start;
    }

    if (this.fd !== null) {
      process.nextTick(function() {
        self._read();
      });
      return;
    }

    fs.open(this.path, this.flags, this.mode, function (err, fd) {
      if (err) {
        self.emit('error', err);
        self.readable = false;
        return;
      }

      self.fd = fd;
      self.emit('open', fd);
      self._read();
    })
  }

  function WriteStream (path, options) {
    if (!(this instanceof WriteStream)) return new WriteStream(path, options);

    Stream.call(this);

    this.path = path;
    this.fd = null;
    this.writable = true;

    this.flags = 'w';
    this.encoding = 'binary';
    this.mode = 438; /*=0666*/
    this.bytesWritten = 0;

    options = options || {};

    // Mixin options into this
    var keys = Object.keys(options);
    for (var index = 0, length = keys.length; index < length; index++) {
      var key = keys[index];
      this[key] = options[key];
    }

    if (this.start !== undefined) {
      if ('number' !== typeof this.start) {
        throw TypeError('start must be a Number');
      }
      if (this.start < 0) {
        throw new Error('start must be >= zero');
      }

      this.pos = this.start;
    }

    this.busy = false;
    this._queue = [];

    if (this.fd === null) {
      this._open = fs.open;
      this._queue.push([this._open, this.path, this.flags, this.mode, undefined]);
      this.flush();
    }
  }
}


/***/ }),

/***/ 263:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

var constants = __nccwpck_require__(1071)

var origCwd = process.cwd
var cwd = null

var platform = process.env.GRACEFUL_FS_PLATFORM || process.platform

process.cwd = function() {
  if (!cwd)
    cwd = origCwd.call(process)
  return cwd
}
try {
  process.cwd()
} catch (er) {}

// This check is needed until node.js 12 is required
if (typeof process.chdir === 'function') {
  var chdir = process.chdir
  process.chdir = function (d) {
    cwd = null
    chdir.call(process, d)
  }
  if (Object.setPrototypeOf) Object.setPrototypeOf(process.chdir, chdir)
}

module.exports = patch

function patch (fs) {
  // (re-)implement some things that are known busted or missing.

  // lchmod, broken prior to 0.6.2
  // back-port the fix here.
  if (constants.hasOwnProperty('O_SYMLINK') &&
      process.version.match(/^v0\.6\.[0-2]|^v0\.5\./)) {
    patchLchmod(fs)
  }

  // lutimes implementation, or no-op
  if (!fs.lutimes) {
    patchLutimes(fs)
  }

  // https://github.com/isaacs/node-graceful-fs/issues/4
  // Chown should not fail on einval or eperm if non-root.
  // It should not fail on enosys ever, as this just indicates
  // that a fs doesn't support the intended operation.

  fs.chown = chownFix(fs.chown)
  fs.fchown = chownFix(fs.fchown)
  fs.lchown = chownFix(fs.lchown)

  fs.chmod = chmodFix(fs.chmod)
  fs.fchmod = chmodFix(fs.fchmod)
  fs.lchmod = chmodFix(fs.lchmod)

  fs.chownSync = chownFixSync(fs.chownSync)
  fs.fchownSync = chownFixSync(fs.fchownSync)
  fs.lchownSync = chownFixSync(fs.lchownSync)

  fs.chmodSync = chmodFixSync(fs.chmodSync)
  fs.fchmodSync = chmodFixSync(fs.fchmodSync)
  fs.lchmodSync = chmodFixSync(fs.lchmodSync)

  fs.stat = statFix(fs.stat)
  fs.fstat = statFix(fs.fstat)
  fs.lstat = statFix(fs.lstat)

  fs.statSync = statFixSync(fs.statSync)
  fs.fstatSync = statFixSync(fs.fstatSync)
  fs.lstatSync = statFixSync(fs.lstatSync)

  // if lchmod/lchown do not exist, then make them no-ops
  if (!fs.lchmod) {
    fs.lchmod = function (path, mode, cb) {
      if (cb) process.nextTick(cb)
    }
    fs.lchmodSync = function () {}
  }
  if (!fs.lchown) {
    fs.lchown = function (path, uid, gid, cb) {
      if (cb) process.nextTick(cb)
    }
    fs.lchownSync = function () {}
  }

  // on Windows, A/V software can lock the directory, causing this
  // to fail with an EACCES or EPERM if the directory contains newly
  // created files.  Try again on failure, for up to 60 seconds.

  // Set the timeout this long because some Windows Anti-Virus, such as Parity
  // bit9, may lock files for up to a minute, causing npm package install
  // failures. Also, take care to yield the scheduler. Windows scheduling gives
  // CPU to a busy looping process, which can cause the program causing the lock
  // contention to be starved of CPU by node, so the contention doesn't resolve.
  if (platform === "win32") {
    fs.rename = (function (fs$rename) { return function (from, to, cb) {
      var start = Date.now()
      var backoff = 0;
      fs$rename(from, to, function CB (er) {
        if (er
            && (er.code === "EACCES" || er.code === "EPERM")
            && Date.now() - start < 60000) {
          setTimeout(function() {
            fs.stat(to, function (stater, st) {
              if (stater && stater.code === "ENOENT")
                fs$rename(from, to, CB);
              else
                cb(er)
            })
          }, backoff)
          if (backoff < 100)
            backoff += 10;
          return;
        }
        if (cb) cb(er)
      })
    }})(fs.rename)
  }

  // if read() returns EAGAIN, then just try it again.
  fs.read = (function (fs$read) {
    function read (fd, buffer, offset, length, position, callback_) {
      var callback
      if (callback_ && typeof callback_ === 'function') {
        var eagCounter = 0
        callback = function (er, _, __) {
          if (er && er.code === 'EAGAIN' && eagCounter < 10) {
            eagCounter ++
            return fs$read.call(fs, fd, buffer, offset, length, position, callback)
          }
          callback_.apply(this, arguments)
        }
      }
      return fs$read.call(fs, fd, buffer, offset, length, position, callback)
    }

    // This ensures `util.promisify` works as it does for native `fs.read`.
    if (Object.setPrototypeOf) Object.setPrototypeOf(read, fs$read)
    return read
  })(fs.read)

  fs.readSync = (function (fs$readSync) { return function (fd, buffer, offset, length, position) {
    var eagCounter = 0
    while (true) {
      try {
        return fs$readSync.call(fs, fd, buffer, offset, length, position)
      } catch (er) {
        if (er.code === 'EAGAIN' && eagCounter < 10) {
          eagCounter ++
          continue
        }
        throw er
      }
    }
  }})(fs.readSync)

  function patchLchmod (fs) {
    fs.lchmod = function (path, mode, callback) {
      fs.open( path
             , constants.O_WRONLY | constants.O_SYMLINK
             , mode
             , function (err, fd) {
        if (err) {
          if (callback) callback(err)
          return
        }
        // prefer to return the chmod error, if one occurs,
        // but still try to close, and report closing errors if they occur.
        fs.fchmod(fd, mode, function (err) {
          fs.close(fd, function(err2) {
            if (callback) callback(err || err2)
          })
        })
      })
    }

    fs.lchmodSync = function (path, mode) {
      var fd = fs.openSync(path, constants.O_WRONLY | constants.O_SYMLINK, mode)

      // prefer to return the chmod error, if one occurs,
      // but still try to close, and report closing errors if they occur.
      var threw = true
      var ret
      try {
        ret = fs.fchmodSync(fd, mode)
        threw = false
      } finally {
        if (threw) {
          try {
            fs.closeSync(fd)
          } catch (er) {}
        } else {
          fs.closeSync(fd)
        }
      }
      return ret
    }
  }

  function patchLutimes (fs) {
    if (constants.hasOwnProperty("O_SYMLINK")) {
      fs.lutimes = function (path, at, mt, cb) {
        fs.open(path, constants.O_SYMLINK, function (er, fd) {
          if (er) {
            if (cb) cb(er)
            return
          }
          fs.futimes(fd, at, mt, function (er) {
            fs.close(fd, function (er2) {
              if (cb) cb(er || er2)
            })
          })
        })
      }

      fs.lutimesSync = function (path, at, mt) {
        var fd = fs.openSync(path, constants.O_SYMLINK)
        var ret
        var threw = true
        try {
          ret = fs.futimesSync(fd, at, mt)
          threw = false
        } finally {
          if (threw) {
            try {
              fs.closeSync(fd)
            } catch (er) {}
          } else {
            fs.closeSync(fd)
          }
        }
        return ret
      }

    } else {
      fs.lutimes = function (_a, _b, _c, cb) { if (cb) process.nextTick(cb) }
      fs.lutimesSync = function () {}
    }
  }

  function chmodFix (orig) {
    if (!orig) return orig
    return function (target, mode, cb) {
      return orig.call(fs, target, mode, function (er) {
        if (chownErOk(er)) er = null
        if (cb) cb.apply(this, arguments)
      })
    }
  }

  function chmodFixSync (orig) {
    if (!orig) return orig
    return function (target, mode) {
      try {
        return orig.call(fs, target, mode)
      } catch (er) {
        if (!chownErOk(er)) throw er
      }
    }
  }


  function chownFix (orig) {
    if (!orig) return orig
    return function (target, uid, gid, cb) {
      return orig.call(fs, target, uid, gid, function (er) {
        if (chownErOk(er)) er = null
        if (cb) cb.apply(this, arguments)
      })
    }
  }

  function chownFixSync (orig) {
    if (!orig) return orig
    return function (target, uid, gid) {
      try {
        return orig.call(fs, target, uid, gid)
      } catch (er) {
        if (!chownErOk(er)) throw er
      }
    }
  }

  function statFix (orig) {
    if (!orig) return orig
    // Older versions of Node erroneously returned signed integers for
    // uid + gid.
    return function (target, options, cb) {
      if (typeof options === 'function') {
        cb = options
        options = null
      }
      function callback (er, stats) {
        if (stats) {
          if (stats.uid < 0) stats.uid += 0x100000000
          if (stats.gid < 0) stats.gid += 0x100000000
        }
        if (cb) cb.apply(this, arguments)
      }
      return options ? orig.call(fs, target, options, callback)
        : orig.call(fs, target, callback)
    }
  }

  function statFixSync (orig) {
    if (!orig) return orig
    // Older versions of Node erroneously returned signed integers for
    // uid + gid.
    return function (target, options) {
      var stats = options ? orig.call(fs, target, options)
        : orig.call(fs, target)
      if (stats.uid < 0) stats.uid += 0x100000000
      if (stats.gid < 0) stats.gid += 0x100000000
      return stats;
    }
  }

  // ENOSYS means that the fs doesn't support the op. Just ignore
  // that, because it doesn't matter.
  //
  // if there's no getuid, or if getuid() is something other
  // than 0, and the error is EINVAL or EPERM, then just ignore
  // it.
  //
  // This specific case is a silent failure in cp, install, tar,
  // and most other unix tools that manage permissions.
  //
  // When running as root, or if other types of errors are
  // encountered, then it's strict.
  function chownErOk (er) {
    if (!er)
      return true

    if (er.code === "ENOSYS")
      return true

    var nonroot = !process.getuid || process.getuid() !== 0
    if (nonroot) {
      if (er.code === "EINVAL" || er.code === "EPERM")
        return true
    }

    return false
  }
}


/***/ }),

/***/ 9562:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * has-glob <https://github.com/jonschlinkert/has-glob>
 *
 * Copyright (c) 2015, Jon Schlinkert.
 * Licensed under the MIT License.
 */



var isGlob = __nccwpck_require__(4466);

module.exports = function hasGlob(val) {
  if (val == null) return false;
  if (typeof val === 'string') {
    return isGlob(val);
  }
  if (Array.isArray(val)) {
    var len = val.length;
    while (len--) {
      if (isGlob(val[len])) {
        return true;
      }
    }
  }
  return false;
};


/***/ }),

/***/ 8887:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * has-value <https://github.com/jonschlinkert/has-value>
 *
 * Copyright (c) 2014-2017, Jon Schlinkert.
 * Licensed under the MIT License.
 */



var isObject = __nccwpck_require__(5509);
var hasValues = __nccwpck_require__(4079);
var get = __nccwpck_require__(9611);

module.exports = function(val, prop) {
  return hasValues(isObject(val) && prop ? get(val, prop) : val);
};


/***/ }),

/***/ 4079:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * has-values <https://github.com/jonschlinkert/has-values>
 *
 * Copyright (c) 2014-2015, 2017, Jon Schlinkert.
 * Released under the MIT License.
 */



var typeOf = __nccwpck_require__(1066);
var isNumber = __nccwpck_require__(5680);

module.exports = function hasValue(val) {
  // is-number checks for NaN and other edge cases
  if (isNumber(val)) {
    return true;
  }

  switch (typeOf(val)) {
    case 'null':
    case 'boolean':
    case 'function':
      return true;
    case 'string':
    case 'arguments':
      return val.length !== 0;
    case 'error':
      return val.message !== '';
    case 'array':
      var len = val.length;
      if (len === 0) {
        return false;
      }
      for (var i = 0; i < len; i++) {
        if (hasValue(val[i])) {
          return true;
        }
      }
      return false;
    case 'file':
    case 'map':
    case 'set':
      return val.size !== 0;
    case 'object':
      var keys = Object.keys(val);
      if (keys.length === 0) {
        return false;
      }
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (hasValue(val[key])) {
          return true;
        }
      }
      return false;
    default: {
      return false;
    }
  }
};


/***/ }),

/***/ 1066:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

var isBuffer = __nccwpck_require__(5625);
var toString = Object.prototype.toString;

/**
 * Get the native `typeof` a value.
 *
 * @param  {*} `val`
 * @return {*} Native javascript type
 */

module.exports = function kindOf(val) {
  // primitivies
  if (typeof val === 'undefined') {
    return 'undefined';
  }
  if (val === null) {
    return 'null';
  }
  if (val === true || val === false || val instanceof Boolean) {
    return 'boolean';
  }
  if (typeof val === 'string' || val instanceof String) {
    return 'string';
  }
  if (typeof val === 'number' || val instanceof Number) {
    return 'number';
  }

  // functions
  if (typeof val === 'function' || val instanceof Function) {
    return 'function';
  }

  // array
  if (typeof Array.isArray !== 'undefined' && Array.isArray(val)) {
    return 'array';
  }

  // check for instances of RegExp and Date before calling `toString`
  if (val instanceof RegExp) {
    return 'regexp';
  }
  if (val instanceof Date) {
    return 'date';
  }

  // other objects
  var type = toString.call(val);

  if (type === '[object RegExp]') {
    return 'regexp';
  }
  if (type === '[object Date]') {
    return 'date';
  }
  if (type === '[object Arguments]') {
    return 'arguments';
  }
  if (type === '[object Error]') {
    return 'error';
  }
  if (type === '[object Promise]') {
    return 'promise';
  }

  // buffer
  if (isBuffer(val)) {
    return 'buffer';
  }

  // es6: Map, WeakMap, Set, WeakSet
  if (type === '[object Set]') {
    return 'set';
  }
  if (type === '[object WeakSet]') {
    return 'weakset';
  }
  if (type === '[object Map]') {
    return 'map';
  }
  if (type === '[object WeakMap]') {
    return 'weakmap';
  }
  if (type === '[object Symbol]') {
    return 'symbol';
  }

  // typed arrays
  if (type === '[object Int8Array]') {
    return 'int8array';
  }
  if (type === '[object Uint8Array]') {
    return 'uint8array';
  }
  if (type === '[object Uint8ClampedArray]') {
    return 'uint8clampedarray';
  }
  if (type === '[object Int16Array]') {
    return 'int16array';
  }
  if (type === '[object Uint16Array]') {
    return 'uint16array';
  }
  if (type === '[object Int32Array]') {
    return 'int32array';
  }
  if (type === '[object Uint32Array]') {
    return 'uint32array';
  }
  if (type === '[object Float32Array]') {
    return 'float32array';
  }
  if (type === '[object Float64Array]') {
    return 'float64array';
  }

  // must be a plain object
  return 'object';
};


/***/ }),

/***/ 1230:
/***/ ((module) => {

// A simple implementation of make-array
function make_array (subject) {
  return Array.isArray(subject)
    ? subject
    : [subject]
}

const REGEX_BLANK_LINE = /^\s+$/
const REGEX_LEADING_EXCAPED_EXCLAMATION = /^\\!/
const REGEX_LEADING_EXCAPED_HASH = /^\\#/
const SLASH = '/'
const KEY_IGNORE = typeof Symbol !== 'undefined'
  ? Symbol.for('node-ignore')
  /* istanbul ignore next */
  : 'node-ignore'

const define = (object, key, value) =>
  Object.defineProperty(object, key, {value})

const REGEX_REGEXP_RANGE = /([0-z])-([0-z])/g

// Sanitize the range of a regular expression
// The cases are complicated, see test cases for details
const sanitizeRange = range => range.replace(
  REGEX_REGEXP_RANGE,
  (match, from, to) => from.charCodeAt(0) <= to.charCodeAt(0)
    ? match
    // Invalid range (out of order) which is ok for gitignore rules but
    //   fatal for JavaScript regular expression, so eliminate it.
    : ''
)

// > If the pattern ends with a slash,
// > it is removed for the purpose of the following description,
// > but it would only find a match with a directory.
// > In other words, foo/ will match a directory foo and paths underneath it,
// > but will not match a regular file or a symbolic link foo
// >  (this is consistent with the way how pathspec works in general in Git).
// '`foo/`' will not match regular file '`foo`' or symbolic link '`foo`'
// -> ignore-rules will not deal with it, because it costs extra `fs.stat` call
//      you could use option `mark: true` with `glob`

// '`foo/`' should not continue with the '`..`'
const DEFAULT_REPLACER_PREFIX = [

  // > Trailing spaces are ignored unless they are quoted with backslash ("\")
  [
    // (a\ ) -> (a )
    // (a  ) -> (a)
    // (a \ ) -> (a  )
    /\\?\s+$/,
    match => match.indexOf('\\') === 0
      ? ' '
      : ''
  ],

  // replace (\ ) with ' '
  [
    /\\\s/g,
    () => ' '
  ],

  // Escape metacharacters
  // which is written down by users but means special for regular expressions.

  // > There are 12 characters with special meanings:
  // > - the backslash \,
  // > - the caret ^,
  // > - the dollar sign $,
  // > - the period or dot .,
  // > - the vertical bar or pipe symbol |,
  // > - the question mark ?,
  // > - the asterisk or star *,
  // > - the plus sign +,
  // > - the opening parenthesis (,
  // > - the closing parenthesis ),
  // > - and the opening square bracket [,
  // > - the opening curly brace {,
  // > These special characters are often called "metacharacters".
  [
    /[\\^$.|*+(){]/g,
    match => `\\${match}`
  ],

  [
    // > [abc] matches any character inside the brackets
    // >    (in this case a, b, or c);
    /\[([^\]/]*)($|\])/g,
    (match, p1, p2) => p2 === ']'
      ? `[${sanitizeRange(p1)}]`
      : `\\${match}`
  ],

  [
    // > a question mark (?) matches a single character
    /(?!\\)\?/g,
    () => '[^/]'
  ],

  // leading slash
  [

    // > A leading slash matches the beginning of the pathname.
    // > For example, "/*.c" matches "cat-file.c" but not "mozilla-sha1/sha1.c".
    // A leading slash matches the beginning of the pathname
    /^\//,
    () => '^'
  ],

  // replace special metacharacter slash after the leading slash
  [
    /\//g,
    () => '\\/'
  ],

  [
    // > A leading "**" followed by a slash means match in all directories.
    // > For example, "**/foo" matches file or directory "foo" anywhere,
    // > the same as pattern "foo".
    // > "**/foo/bar" matches file or directory "bar" anywhere that is directly
    // >   under directory "foo".
    // Notice that the '*'s have been replaced as '\\*'
    /^\^*\\\*\\\*\\\//,

    // '**/foo' <-> 'foo'
    () => '^(?:.*\\/)?'
  ]
]

const DEFAULT_REPLACER_SUFFIX = [
  // starting
  [
    // there will be no leading '/'
    //   (which has been replaced by section "leading slash")
    // If starts with '**', adding a '^' to the regular expression also works
    /^(?=[^^])/,
    function startingReplacer () {
      return !/\/(?!$)/.test(this)
        // > If the pattern does not contain a slash /,
        // >   Git treats it as a shell glob pattern
        // Actually, if there is only a trailing slash,
        //   git also treats it as a shell glob pattern
        ? '(?:^|\\/)'

        // > Otherwise, Git treats the pattern as a shell glob suitable for
        // >   consumption by fnmatch(3)
        : '^'
    }
  ],

  // two globstars
  [
    // Use lookahead assertions so that we could match more than one `'/**'`
    /\\\/\\\*\\\*(?=\\\/|$)/g,

    // Zero, one or several directories
    // should not use '*', or it will be replaced by the next replacer

    // Check if it is not the last `'/**'`
    (match, index, str) => index + 6 < str.length

      // case: /**/
      // > A slash followed by two consecutive asterisks then a slash matches
      // >   zero or more directories.
      // > For example, "a/**/b" matches "a/b", "a/x/b", "a/x/y/b" and so on.
      // '/**/'
      ? '(?:\\/[^\\/]+)*'

      // case: /**
      // > A trailing `"/**"` matches everything inside.

      // #21: everything inside but it should not include the current folder
      : '\\/.+'
  ],

  // intermediate wildcards
  [
    // Never replace escaped '*'
    // ignore rule '\*' will match the path '*'

    // 'abc.*/' -> go
    // 'abc.*'  -> skip this rule
    /(^|[^\\]+)\\\*(?=.+)/g,

    // '*.js' matches '.js'
    // '*.js' doesn't match 'abc'
    (match, p1) => `${p1}[^\\/]*`
  ],

  // trailing wildcard
  [
    /(\^|\\\/)?\\\*$/,
    (match, p1) => {
      const prefix = p1
        // '\^':
        // '/*' does not match ''
        // '/*' does not match everything

        // '\\\/':
        // 'abc/*' does not match 'abc/'
        ? `${p1}[^/]+`

        // 'a*' matches 'a'
        // 'a*' matches 'aa'
        : '[^/]*'

      return `${prefix}(?=$|\\/$)`
    }
  ],

  [
    // unescape
    /\\\\\\/g,
    () => '\\'
  ]
]

const POSITIVE_REPLACERS = [
  ...DEFAULT_REPLACER_PREFIX,

  // 'f'
  // matches
  // - /f(end)
  // - /f/
  // - (start)f(end)
  // - (start)f/
  // doesn't match
  // - oof
  // - foo
  // pseudo:
  // -> (^|/)f(/|$)

  // ending
  [
    // 'js' will not match 'js.'
    // 'ab' will not match 'abc'
    /(?:[^*/])$/,

    // 'js*' will not match 'a.js'
    // 'js/' will not match 'a.js'
    // 'js' will match 'a.js' and 'a.js/'
    match => `${match}(?=$|\\/)`
  ],

  ...DEFAULT_REPLACER_SUFFIX
]

const NEGATIVE_REPLACERS = [
  ...DEFAULT_REPLACER_PREFIX,

  // #24, #38
  // The MISSING rule of [gitignore docs](https://git-scm.com/docs/gitignore)
  // A negative pattern without a trailing wildcard should not
  // re-include the things inside that directory.

  // eg:
  // ['node_modules/*', '!node_modules']
  // should ignore `node_modules/a.js`
  [
    /(?:[^*])$/,
    match => `${match}(?=$|\\/$)`
  ],

  ...DEFAULT_REPLACER_SUFFIX
]

// A simple cache, because an ignore rule only has only one certain meaning
const cache = Object.create(null)

// @param {pattern}
const make_regex = (pattern, negative, ignorecase) => {
  const r = cache[pattern]
  if (r) {
    return r
  }

  const replacers = negative
    ? NEGATIVE_REPLACERS
    : POSITIVE_REPLACERS

  const source = replacers.reduce(
    (prev, current) => prev.replace(current[0], current[1].bind(pattern)),
    pattern
  )

  return cache[pattern] = ignorecase
    ? new RegExp(source, 'i')
    : new RegExp(source)
}

// > A blank line matches no files, so it can serve as a separator for readability.
const checkPattern = pattern => pattern
  && typeof pattern === 'string'
  && !REGEX_BLANK_LINE.test(pattern)

  // > A line starting with # serves as a comment.
  && pattern.indexOf('#') !== 0

const createRule = (pattern, ignorecase) => {
  const origin = pattern
  let negative = false

  // > An optional prefix "!" which negates the pattern;
  if (pattern.indexOf('!') === 0) {
    negative = true
    pattern = pattern.substr(1)
  }

  pattern = pattern
  // > Put a backslash ("\") in front of the first "!" for patterns that
  // >   begin with a literal "!", for example, `"\!important!.txt"`.
  .replace(REGEX_LEADING_EXCAPED_EXCLAMATION, '!')
  // > Put a backslash ("\") in front of the first hash for patterns that
  // >   begin with a hash.
  .replace(REGEX_LEADING_EXCAPED_HASH, '#')

  const regex = make_regex(pattern, negative, ignorecase)

  return {
    origin,
    pattern,
    negative,
    regex
  }
}

class IgnoreBase {
  constructor ({
    ignorecase = true
  } = {}) {
    this._rules = []
    this._ignorecase = ignorecase
    define(this, KEY_IGNORE, true)
    this._initCache()
  }

  _initCache () {
    this._cache = Object.create(null)
  }

  // @param {Array.<string>|string|Ignore} pattern
  add (pattern) {
    this._added = false

    if (typeof pattern === 'string') {
      pattern = pattern.split(/\r?\n/g)
    }

    make_array(pattern).forEach(this._addPattern, this)

    // Some rules have just added to the ignore,
    // making the behavior changed.
    if (this._added) {
      this._initCache()
    }

    return this
  }

  // legacy
  addPattern (pattern) {
    return this.add(pattern)
  }

  _addPattern (pattern) {
    // #32
    if (pattern && pattern[KEY_IGNORE]) {
      this._rules = this._rules.concat(pattern._rules)
      this._added = true
      return
    }

    if (checkPattern(pattern)) {
      const rule = createRule(pattern, this._ignorecase)
      this._added = true
      this._rules.push(rule)
    }
  }

  filter (paths) {
    return make_array(paths).filter(path => this._filter(path))
  }

  createFilter () {
    return path => this._filter(path)
  }

  ignores (path) {
    return !this._filter(path)
  }

  // @returns `Boolean` true if the `path` is NOT ignored
  _filter (path, slices) {
    if (!path) {
      return false
    }

    if (path in this._cache) {
      return this._cache[path]
    }

    if (!slices) {
      // path/to/a.js
      // ['path', 'to', 'a.js']
      slices = path.split(SLASH)
    }

    slices.pop()

    return this._cache[path] = slices.length
      // > It is not possible to re-include a file if a parent directory of
      // >   that file is excluded.
      // If the path contains a parent directory, check the parent first
      ? this._filter(slices.join(SLASH) + SLASH, slices)
        && this._test(path)

      // Or only test the path
      : this._test(path)
  }

  // @returns {Boolean} true if a file is NOT ignored
  _test (path) {
    // Explicitly define variable type by setting matched to `0`
    let matched = 0

    this._rules.forEach(rule => {
      // if matched = true, then we only test negative rules
      // if matched = false, then we test non-negative rules
      if (!(matched ^ rule.negative)) {
        matched = rule.negative ^ rule.regex.test(path)
      }
    })

    return !matched
  }
}

// Windows
// --------------------------------------------------------------
/* istanbul ignore if  */
if (
  // Detect `process` so that it can run in browsers.
  typeof process !== 'undefined'
  && (
    process.env && process.env.IGNORE_TEST_WIN32
    || process.platform === 'win32'
  )
) {
  const filter = IgnoreBase.prototype._filter

  /* eslint no-control-regex: "off" */
  const make_posix = str => /^\\\\\?\\/.test(str)
  || /[^\x00-\x80]+/.test(str)
    ? str
    : str.replace(/\\/g, '/')

  IgnoreBase.prototype._filter = function filterWin32 (path, slices) {
    path = make_posix(path)
    return filter.call(this, path, slices)
  }
}

module.exports = options => new IgnoreBase(options)


/***/ }),

/***/ 8043:
/***/ ((module) => {



module.exports = (string, count = 1, options) => {
	options = {
		indent: ' ',
		includeEmptyLines: false,
		...options
	};

	if (typeof string !== 'string') {
		throw new TypeError(
			`Expected \`input\` to be a \`string\`, got \`${typeof string}\``
		);
	}

	if (typeof count !== 'number') {
		throw new TypeError(
			`Expected \`count\` to be a \`number\`, got \`${typeof count}\``
		);
	}

	if (typeof options.indent !== 'string') {
		throw new TypeError(
			`Expected \`options.indent\` to be a \`string\`, got \`${typeof options.indent}\``
		);
	}

	if (count === 0) {
		return string;
	}

	const regex = options.includeEmptyLines ? /^/gm : /^(?!\s*$)/gm;

	return string.replace(regex, options.indent.repeat(count));
};


/***/ }),

/***/ 2492:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

var wrappy = __nccwpck_require__(2940)
var reqs = Object.create(null)
var once = __nccwpck_require__(1223)

module.exports = wrappy(inflight)

function inflight (key, cb) {
  if (reqs[key]) {
    reqs[key].push(cb)
    return null
  } else {
    reqs[key] = [cb]
    return makeres(key)
  }
}

function makeres (key) {
  return once(function RES () {
    var cbs = reqs[key]
    var len = cbs.length
    var args = slice(arguments)

    // XXX It's somewhat ambiguous whether a new callback added in this
    // pass should be queued for later execution if something in the
    // list of callbacks throws, or if it should just be discarded.
    // However, it's such an edge case that it hardly matters, and either
    // choice is likely as surprising as the other.
    // As it happens, we do go ahead and schedule it for later execution.
    try {
      for (var i = 0; i < len; i++) {
        cbs[i].apply(null, args)
      }
    } finally {
      if (cbs.length > len) {
        // added more in the interim.
        // de-zalgo, just in case, but don't call again.
        cbs.splice(0, len)
        process.nextTick(function () {
          RES.apply(null, args)
        })
      } else {
        delete reqs[key]
      }
    }
  })
}

function slice (args) {
  var length = args.length
  var array = []

  for (var i = 0; i < length; i++) array[i] = args[i]
  return array
}


/***/ }),

/***/ 4124:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

try {
  var util = __nccwpck_require__(3837);
  /* istanbul ignore next */
  if (typeof util.inherits !== 'function') throw '';
  module.exports = util.inherits;
} catch (e) {
  /* istanbul ignore next */
  module.exports = __nccwpck_require__(8544);
}


/***/ }),

/***/ 8544:
/***/ ((module) => {

if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    if (superCtor) {
      ctor.super_ = superCtor
      ctor.prototype = Object.create(superCtor.prototype, {
        constructor: {
          value: ctor,
          enumerable: false,
          writable: true,
          configurable: true
        }
      })
    }
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    if (superCtor) {
      ctor.super_ = superCtor
      var TempCtor = function () {}
      TempCtor.prototype = superCtor.prototype
      ctor.prototype = new TempCtor()
      ctor.prototype.constructor = ctor
    }
  }
}


/***/ }),

/***/ 6649:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * is-accessor-descriptor <https://github.com/jonschlinkert/is-accessor-descriptor>
 *
 * Copyright (c) 2015-2017, Jon Schlinkert.
 * Released under the MIT License.
 */



var typeOf = __nccwpck_require__(5619);

// accessor descriptor properties
var accessor = {
  get: 'function',
  set: 'function',
  configurable: 'boolean',
  enumerable: 'boolean'
};

function isAccessorDescriptor(obj, prop) {
  if (typeof prop === 'string') {
    var val = Object.getOwnPropertyDescriptor(obj, prop);
    return typeof val !== 'undefined';
  }

  if (typeOf(obj) !== 'object') {
    return false;
  }

  if (has(obj, 'value') || has(obj, 'writable')) {
    return false;
  }

  if (!has(obj, 'get') || typeof obj.get !== 'function') {
    return false;
  }

  // tldr: it's valid to have "set" be undefined
  // "set" might be undefined if `Object.getOwnPropertyDescriptor`
  // was used to get the value, and only `get` was defined by the user
  if (has(obj, 'set') && typeof obj[key] !== 'function' && typeof obj[key] !== 'undefined') {
    return false;
  }

  for (var key in obj) {
    if (!accessor.hasOwnProperty(key)) {
      continue;
    }

    if (typeOf(obj[key]) === accessor[key]) {
      continue;
    }

    if (typeof obj[key] !== 'undefined') {
      return false;
    }
  }
  return true;
}

function has(obj, key) {
  return {}.hasOwnProperty.call(obj, key);
}

/**
 * Expose `isAccessorDescriptor`
 */

module.exports = isAccessorDescriptor;


/***/ }),

/***/ 5619:
/***/ ((module) => {

var toString = Object.prototype.toString;

module.exports = function kindOf(val) {
  if (val === void 0) return 'undefined';
  if (val === null) return 'null';

  var type = typeof val;
  if (type === 'boolean') return 'boolean';
  if (type === 'string') return 'string';
  if (type === 'number') return 'number';
  if (type === 'symbol') return 'symbol';
  if (type === 'function') {
    return isGeneratorFn(val) ? 'generatorfunction' : 'function';
  }

  if (isArray(val)) return 'array';
  if (isBuffer(val)) return 'buffer';
  if (isArguments(val)) return 'arguments';
  if (isDate(val)) return 'date';
  if (isError(val)) return 'error';
  if (isRegexp(val)) return 'regexp';

  switch (ctorName(val)) {
    case 'Symbol': return 'symbol';
    case 'Promise': return 'promise';

    // Set, Map, WeakSet, WeakMap
    case 'WeakMap': return 'weakmap';
    case 'WeakSet': return 'weakset';
    case 'Map': return 'map';
    case 'Set': return 'set';

    // 8-bit typed arrays
    case 'Int8Array': return 'int8array';
    case 'Uint8Array': return 'uint8array';
    case 'Uint8ClampedArray': return 'uint8clampedarray';

    // 16-bit typed arrays
    case 'Int16Array': return 'int16array';
    case 'Uint16Array': return 'uint16array';

    // 32-bit typed arrays
    case 'Int32Array': return 'int32array';
    case 'Uint32Array': return 'uint32array';
    case 'Float32Array': return 'float32array';
    case 'Float64Array': return 'float64array';
  }

  if (isGeneratorObj(val)) {
    return 'generator';
  }

  // Non-plain objects
  type = toString.call(val);
  switch (type) {
    case '[object Object]': return 'object';
    // iterators
    case '[object Map Iterator]': return 'mapiterator';
    case '[object Set Iterator]': return 'setiterator';
    case '[object String Iterator]': return 'stringiterator';
    case '[object Array Iterator]': return 'arrayiterator';
  }

  // other
  return type.slice(8, -1).toLowerCase().replace(/\s/g, '');
};

function ctorName(val) {
  return typeof val.constructor === 'function' ? val.constructor.name : null;
}

function isArray(val) {
  if (Array.isArray) return Array.isArray(val);
  return val instanceof Array;
}

function isError(val) {
  return val instanceof Error || (typeof val.message === 'string' && val.constructor && typeof val.constructor.stackTraceLimit === 'number');
}

function isDate(val) {
  if (val instanceof Date) return true;
  return typeof val.toDateString === 'function'
    && typeof val.getDate === 'function'
    && typeof val.setDate === 'function';
}

function isRegexp(val) {
  if (val instanceof RegExp) return true;
  return typeof val.flags === 'string'
    && typeof val.ignoreCase === 'boolean'
    && typeof val.multiline === 'boolean'
    && typeof val.global === 'boolean';
}

function isGeneratorFn(name, val) {
  return ctorName(name) === 'GeneratorFunction';
}

function isGeneratorObj(val) {
  return typeof val.throw === 'function'
    && typeof val.return === 'function'
    && typeof val.next === 'function';
}

function isArguments(val) {
  try {
    if (typeof val.length === 'number' && typeof val.callee === 'function') {
      return true;
    }
  } catch (err) {
    if (err.message.indexOf('callee') !== -1) {
      return true;
    }
  }
  return false;
}

/**
 * If you need to support Safari 5-7 (8-10 yr-old browser),
 * take a look at https://github.com/feross/is-buffer
 */

function isBuffer(val) {
  if (val.constructor && typeof val.constructor.isBuffer === 'function') {
    return val.constructor.isBuffer(val);
  }
  return false;
}


/***/ }),

/***/ 5625:
/***/ ((module) => {

/*!
 * Determine if an object is a Buffer
 *
 * @author   Feross Aboukhadijeh <https://feross.org>
 * @license  MIT
 */

// The _isBuffer check is for Safari 5-7 support, because it's missing
// Object.prototype.constructor. Remove this eventually
module.exports = function (obj) {
  return obj != null && (isBuffer(obj) || isSlowBuffer(obj) || !!obj._isBuffer)
}

function isBuffer (obj) {
  return !!obj.constructor && typeof obj.constructor.isBuffer === 'function' && obj.constructor.isBuffer(obj)
}

// For Node v0.10 support. Remove this eventually.
function isSlowBuffer (obj) {
  return typeof obj.readFloatLE === 'function' && typeof obj.slice === 'function' && isBuffer(obj.slice(0, 0))
}


/***/ }),

/***/ 1598:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * is-data-descriptor <https://github.com/jonschlinkert/is-data-descriptor>
 *
 * Copyright (c) 2015-2017, Jon Schlinkert.
 * Released under the MIT License.
 */



var typeOf = __nccwpck_require__(3131);

module.exports = function isDataDescriptor(obj, prop) {
  // data descriptor properties
  var data = {
    configurable: 'boolean',
    enumerable: 'boolean',
    writable: 'boolean'
  };

  if (typeOf(obj) !== 'object') {
    return false;
  }

  if (typeof prop === 'string') {
    var val = Object.getOwnPropertyDescriptor(obj, prop);
    return typeof val !== 'undefined';
  }

  if (!('value' in obj) && !('writable' in obj)) {
    return false;
  }

  for (var key in obj) {
    if (key === 'value') continue;

    if (!data.hasOwnProperty(key)) {
      continue;
    }

    if (typeOf(obj[key]) === data[key]) {
      continue;
    }

    if (typeof obj[key] !== 'undefined') {
      return false;
    }
  }
  return true;
};


/***/ }),

/***/ 3131:
/***/ ((module) => {

var toString = Object.prototype.toString;

module.exports = function kindOf(val) {
  if (val === void 0) return 'undefined';
  if (val === null) return 'null';

  var type = typeof val;
  if (type === 'boolean') return 'boolean';
  if (type === 'string') return 'string';
  if (type === 'number') return 'number';
  if (type === 'symbol') return 'symbol';
  if (type === 'function') {
    return isGeneratorFn(val) ? 'generatorfunction' : 'function';
  }

  if (isArray(val)) return 'array';
  if (isBuffer(val)) return 'buffer';
  if (isArguments(val)) return 'arguments';
  if (isDate(val)) return 'date';
  if (isError(val)) return 'error';
  if (isRegexp(val)) return 'regexp';

  switch (ctorName(val)) {
    case 'Symbol': return 'symbol';
    case 'Promise': return 'promise';

    // Set, Map, WeakSet, WeakMap
    case 'WeakMap': return 'weakmap';
    case 'WeakSet': return 'weakset';
    case 'Map': return 'map';
    case 'Set': return 'set';

    // 8-bit typed arrays
    case 'Int8Array': return 'int8array';
    case 'Uint8Array': return 'uint8array';
    case 'Uint8ClampedArray': return 'uint8clampedarray';

    // 16-bit typed arrays
    case 'Int16Array': return 'int16array';
    case 'Uint16Array': return 'uint16array';

    // 32-bit typed arrays
    case 'Int32Array': return 'int32array';
    case 'Uint32Array': return 'uint32array';
    case 'Float32Array': return 'float32array';
    case 'Float64Array': return 'float64array';
  }

  if (isGeneratorObj(val)) {
    return 'generator';
  }

  // Non-plain objects
  type = toString.call(val);
  switch (type) {
    case '[object Object]': return 'object';
    // iterators
    case '[object Map Iterator]': return 'mapiterator';
    case '[object Set Iterator]': return 'setiterator';
    case '[object String Iterator]': return 'stringiterator';
    case '[object Array Iterator]': return 'arrayiterator';
  }

  // other
  return type.slice(8, -1).toLowerCase().replace(/\s/g, '');
};

function ctorName(val) {
  return typeof val.constructor === 'function' ? val.constructor.name : null;
}

function isArray(val) {
  if (Array.isArray) return Array.isArray(val);
  return val instanceof Array;
}

function isError(val) {
  return val instanceof Error || (typeof val.message === 'string' && val.constructor && typeof val.constructor.stackTraceLimit === 'number');
}

function isDate(val) {
  if (val instanceof Date) return true;
  return typeof val.toDateString === 'function'
    && typeof val.getDate === 'function'
    && typeof val.setDate === 'function';
}

function isRegexp(val) {
  if (val instanceof RegExp) return true;
  return typeof val.flags === 'string'
    && typeof val.ignoreCase === 'boolean'
    && typeof val.multiline === 'boolean'
    && typeof val.global === 'boolean';
}

function isGeneratorFn(name, val) {
  return ctorName(name) === 'GeneratorFunction';
}

function isGeneratorObj(val) {
  return typeof val.throw === 'function'
    && typeof val.return === 'function'
    && typeof val.next === 'function';
}

function isArguments(val) {
  try {
    if (typeof val.length === 'number' && typeof val.callee === 'function') {
      return true;
    }
  } catch (err) {
    if (err.message.indexOf('callee') !== -1) {
      return true;
    }
  }
  return false;
}

/**
 * If you need to support Safari 5-7 (8-10 yr-old browser),
 * take a look at https://github.com/feross/is-buffer
 */

function isBuffer(val) {
  if (val.constructor && typeof val.constructor.isBuffer === 'function') {
    return val.constructor.isBuffer(val);
  }
  return false;
}


/***/ }),

/***/ 567:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * is-descriptor <https://github.com/jonschlinkert/is-descriptor>
 *
 * Copyright (c) 2015-2017, Jon Schlinkert.
 * Released under the MIT License.
 */



var typeOf = __nccwpck_require__(8267);
var isAccessor = __nccwpck_require__(6649);
var isData = __nccwpck_require__(1598);

module.exports = function isDescriptor(obj, key) {
  if (typeOf(obj) !== 'object') {
    return false;
  }
  if ('get' in obj) {
    return isAccessor(obj, key);
  }
  return isData(obj, key);
};


/***/ }),

/***/ 8267:
/***/ ((module) => {

var toString = Object.prototype.toString;

module.exports = function kindOf(val) {
  if (val === void 0) return 'undefined';
  if (val === null) return 'null';

  var type = typeof val;
  if (type === 'boolean') return 'boolean';
  if (type === 'string') return 'string';
  if (type === 'number') return 'number';
  if (type === 'symbol') return 'symbol';
  if (type === 'function') {
    return isGeneratorFn(val) ? 'generatorfunction' : 'function';
  }

  if (isArray(val)) return 'array';
  if (isBuffer(val)) return 'buffer';
  if (isArguments(val)) return 'arguments';
  if (isDate(val)) return 'date';
  if (isError(val)) return 'error';
  if (isRegexp(val)) return 'regexp';

  switch (ctorName(val)) {
    case 'Symbol': return 'symbol';
    case 'Promise': return 'promise';

    // Set, Map, WeakSet, WeakMap
    case 'WeakMap': return 'weakmap';
    case 'WeakSet': return 'weakset';
    case 'Map': return 'map';
    case 'Set': return 'set';

    // 8-bit typed arrays
    case 'Int8Array': return 'int8array';
    case 'Uint8Array': return 'uint8array';
    case 'Uint8ClampedArray': return 'uint8clampedarray';

    // 16-bit typed arrays
    case 'Int16Array': return 'int16array';
    case 'Uint16Array': return 'uint16array';

    // 32-bit typed arrays
    case 'Int32Array': return 'int32array';
    case 'Uint32Array': return 'uint32array';
    case 'Float32Array': return 'float32array';
    case 'Float64Array': return 'float64array';
  }

  if (isGeneratorObj(val)) {
    return 'generator';
  }

  // Non-plain objects
  type = toString.call(val);
  switch (type) {
    case '[object Object]': return 'object';
    // iterators
    case '[object Map Iterator]': return 'mapiterator';
    case '[object Set Iterator]': return 'setiterator';
    case '[object String Iterator]': return 'stringiterator';
    case '[object Array Iterator]': return 'arrayiterator';
  }

  // other
  return type.slice(8, -1).toLowerCase().replace(/\s/g, '');
};

function ctorName(val) {
  return typeof val.constructor === 'function' ? val.constructor.name : null;
}

function isArray(val) {
  if (Array.isArray) return Array.isArray(val);
  return val instanceof Array;
}

function isError(val) {
  return val instanceof Error || (typeof val.message === 'string' && val.constructor && typeof val.constructor.stackTraceLimit === 'number');
}

function isDate(val) {
  if (val instanceof Date) return true;
  return typeof val.toDateString === 'function'
    && typeof val.getDate === 'function'
    && typeof val.setDate === 'function';
}

function isRegexp(val) {
  if (val instanceof RegExp) return true;
  return typeof val.flags === 'string'
    && typeof val.ignoreCase === 'boolean'
    && typeof val.multiline === 'boolean'
    && typeof val.global === 'boolean';
}

function isGeneratorFn(name, val) {
  return ctorName(name) === 'GeneratorFunction';
}

function isGeneratorObj(val) {
  return typeof val.throw === 'function'
    && typeof val.return === 'function'
    && typeof val.next === 'function';
}

function isArguments(val) {
  try {
    if (typeof val.length === 'number' && typeof val.callee === 'function') {
      return true;
    }
  } catch (err) {
    if (err.message.indexOf('callee') !== -1) {
      return true;
    }
  }
  return false;
}

/**
 * If you need to support Safari 5-7 (8-10 yr-old browser),
 * take a look at https://github.com/feross/is-buffer
 */

function isBuffer(val) {
  if (val.constructor && typeof val.constructor.isBuffer === 'function') {
    return val.constructor.isBuffer(val);
  }
  return false;
}


/***/ }),

/***/ 429:
/***/ ((module) => {

/*!
 * is-extendable <https://github.com/jonschlinkert/is-extendable>
 *
 * Copyright (c) 2015, Jon Schlinkert.
 * Licensed under the MIT License.
 */



module.exports = function isExtendable(val) {
  return typeof val !== 'undefined' && val !== null
    && (typeof val === 'object' || typeof val === 'function');
};


/***/ }),

/***/ 6435:
/***/ ((module) => {

/*!
 * is-extglob <https://github.com/jonschlinkert/is-extglob>
 *
 * Copyright (c) 2014-2016, Jon Schlinkert.
 * Licensed under the MIT License.
 */

module.exports = function isExtglob(str) {
  if (typeof str !== 'string' || str === '') {
    return false;
  }

  var match;
  while ((match = /(\\).|([@?!+*]\(.*\))/g.exec(str))) {
    if (match[2]) return true;
    str = str.slice(match.index + match[0].length);
  }

  return false;
};


/***/ }),

/***/ 4466:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * is-glob <https://github.com/jonschlinkert/is-glob>
 *
 * Copyright (c) 2014-2016, Jon Schlinkert.
 * Licensed under the MIT License.
 */

var isExtglob = __nccwpck_require__(6435);

module.exports = function isGlob(str) {
  if (typeof str !== 'string' || str === '') {
    return false;
  }

  if (isExtglob(str)) return true;

  var regex = /(\\).|([*?]|\[.*\]|\{.*\}|\(.*\|.*\)|^!)/;
  var match;

  while ((match = regex.exec(str))) {
    if (match[2]) return true;
    str = str.slice(match.index + match[0].length);
  }
  return false;
};


/***/ }),

/***/ 5680:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * is-number <https://github.com/jonschlinkert/is-number>
 *
 * Copyright (c) 2014-2015, Jon Schlinkert.
 * Licensed under the MIT License.
 */



var typeOf = __nccwpck_require__(6961);

module.exports = function isNumber(num) {
  var type = typeOf(num);

  if (type === 'string') {
    if (!num.trim()) return false;
  } else if (type !== 'number') {
    return false;
  }

  return (num - num + 1) >= 0;
};


/***/ }),

/***/ 7810:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * is-plain-object <https://github.com/jonschlinkert/is-plain-object>
 *
 * Copyright (c) 2014-2017, Jon Schlinkert.
 * Released under the MIT License.
 */



var isObject = __nccwpck_require__(5509);

function isObjectObject(o) {
  return isObject(o) === true
    && Object.prototype.toString.call(o) === '[object Object]';
}

module.exports = function isPlainObject(o) {
  var ctor,prot;

  if (isObjectObject(o) === false) return false;

  // If has modified constructor
  ctor = o.constructor;
  if (typeof ctor !== 'function') return false;

  // If has modified prototype
  prot = ctor.prototype;
  if (isObjectObject(prot) === false) return false;

  // If constructor does not have an Object-specific method
  if (prot.hasOwnProperty('isPrototypeOf') === false) {
    return false;
  }

  // Most likely a plain Object
  return true;
};


/***/ }),

/***/ 9125:
/***/ ((module, exports) => {

/*!
 * is-windows <https://github.com/jonschlinkert/is-windows>
 *
 * Copyright © 2015-2018, Jon Schlinkert.
 * Released under the MIT License.
 */

(function(factory) {
  if (exports && typeof exports === 'object' && "object" !== 'undefined') {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof window !== 'undefined') {
    window.isWindows = factory();
  } else if (typeof global !== 'undefined') {
    global.isWindows = factory();
  } else if (typeof self !== 'undefined') {
    self.isWindows = factory();
  } else {
    this.isWindows = factory();
  }
})(function() {
  'use strict';
  return function isWindows() {
    return process && (process.platform === 'win32' || /^(msys|cygwin)$/.test(process.env.OSTYPE));
  };
});


/***/ }),

/***/ 893:
/***/ ((module) => {

var toString = {}.toString;

module.exports = Array.isArray || function (arr) {
  return toString.call(arr) == '[object Array]';
};


/***/ }),

/***/ 5509:
/***/ ((module) => {

/*!
 * isobject <https://github.com/jonschlinkert/isobject>
 *
 * Copyright (c) 2014-2017, Jon Schlinkert.
 * Released under the MIT License.
 */



module.exports = function isObject(val) {
  return val != null && typeof val === 'object' && Array.isArray(val) === false;
};


/***/ }),

/***/ 4072:
/***/ ((module, exports) => {



const blacklist = [
	// # All
	'^npm-debug\\.log$', // Error log for npm
	'^\\..*\\.swp$', // Swap file for vim state

	// # macOS
	'^\\.DS_Store$', // Stores custom folder attributes
	'^\\.AppleDouble$', // Stores additional file resources
	'^\\.LSOverride$', // Contains the absolute path to the app to be used
	'^Icon\\r$', // Custom Finder icon: http://superuser.com/questions/298785/icon-file-on-os-x-desktop
	'^\\._.*', // Thumbnail
	'^\\.Spotlight-V100(?:$|\\/)', // Directory that might appear on external disk
	'\\.Trashes', // File that might appear on external disk
	'^__MACOSX$', // Resource fork

	// # Linux
	'~$', // Backup file

	// # Windows
	'^Thumbs\\.db$', // Image file cache
	'^ehthumbs\\.db$', // Folder config file
	'^Desktop\\.ini$', // Stores custom folder attributes
	'@eaDir$' // Synology Diskstation "hidden" folder where the server stores thumbnails
];

exports.re = () => {
	throw new Error('`junk.re` was renamed to `junk.regex`');
};

exports.regex = new RegExp(blacklist.join('|'));

exports.is = filename => exports.regex.test(filename);

exports.not = filename => !exports.is(filename);

// TODO: Remove this for the next major release
exports["default"] = module.exports;


/***/ }),

/***/ 6961:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

var isBuffer = __nccwpck_require__(5625);
var toString = Object.prototype.toString;

/**
 * Get the native `typeof` a value.
 *
 * @param  {*} `val`
 * @return {*} Native javascript type
 */

module.exports = function kindOf(val) {
  // primitivies
  if (typeof val === 'undefined') {
    return 'undefined';
  }
  if (val === null) {
    return 'null';
  }
  if (val === true || val === false || val instanceof Boolean) {
    return 'boolean';
  }
  if (typeof val === 'string' || val instanceof String) {
    return 'string';
  }
  if (typeof val === 'number' || val instanceof Number) {
    return 'number';
  }

  // functions
  if (typeof val === 'function' || val instanceof Function) {
    return 'function';
  }

  // array
  if (typeof Array.isArray !== 'undefined' && Array.isArray(val)) {
    return 'array';
  }

  // check for instances of RegExp and Date before calling `toString`
  if (val instanceof RegExp) {
    return 'regexp';
  }
  if (val instanceof Date) {
    return 'date';
  }

  // other objects
  var type = toString.call(val);

  if (type === '[object RegExp]') {
    return 'regexp';
  }
  if (type === '[object Date]') {
    return 'date';
  }
  if (type === '[object Arguments]') {
    return 'arguments';
  }
  if (type === '[object Error]') {
    return 'error';
  }

  // buffer
  if (isBuffer(val)) {
    return 'buffer';
  }

  // es6: Map, WeakMap, Set, WeakSet
  if (type === '[object Set]') {
    return 'set';
  }
  if (type === '[object WeakSet]') {
    return 'weakset';
  }
  if (type === '[object Map]') {
    return 'map';
  }
  if (type === '[object WeakMap]') {
    return 'weakmap';
  }
  if (type === '[object Symbol]') {
    return 'symbol';
  }

  // typed arrays
  if (type === '[object Int8Array]') {
    return 'int8array';
  }
  if (type === '[object Uint8Array]') {
    return 'uint8array';
  }
  if (type === '[object Uint8ClampedArray]') {
    return 'uint8clampedarray';
  }
  if (type === '[object Int16Array]') {
    return 'int16array';
  }
  if (type === '[object Uint16Array]') {
    return 'uint16array';
  }
  if (type === '[object Int32Array]') {
    return 'int32array';
  }
  if (type === '[object Uint32Array]') {
    return 'uint32array';
  }
  if (type === '[object Float32Array]') {
    return 'float32array';
  }
  if (type === '[object Float64Array]') {
    return 'float64array';
  }

  // must be a plain object
  return 'object';
};


/***/ }),

/***/ 9126:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {


const fs = __nccwpck_require__(7147);
const path = __nccwpck_require__(1017);
const {promisify} = __nccwpck_require__(3837);
const semver = __nccwpck_require__(5911);

const useNativeRecursiveOption = semver.satisfies(process.version, '>=10.12.0');

// https://github.com/nodejs/node/issues/8987
// https://github.com/libuv/libuv/pull/1088
const checkPath = pth => {
	if (process.platform === 'win32') {
		const pathHasInvalidWinCharacters = /[<>:"|?*]/.test(pth.replace(path.parse(pth).root, ''));

		if (pathHasInvalidWinCharacters) {
			const error = new Error(`Path contains invalid characters: ${pth}`);
			error.code = 'EINVAL';
			throw error;
		}
	}
};

const processOptions = options => {
	// https://github.com/sindresorhus/make-dir/issues/18
	const defaults = {
		mode: 0o777,
		fs
	};

	return {
		...defaults,
		...options
	};
};

const permissionError = pth => {
	// This replicates the exception of `fs.mkdir` with native the
	// `recusive` option when run on an invalid drive under Windows.
	const error = new Error(`operation not permitted, mkdir '${pth}'`);
	error.code = 'EPERM';
	error.errno = -4048;
	error.path = pth;
	error.syscall = 'mkdir';
	return error;
};

const makeDir = async (input, options) => {
	checkPath(input);
	options = processOptions(options);

	const mkdir = promisify(options.fs.mkdir);
	const stat = promisify(options.fs.stat);

	if (useNativeRecursiveOption && options.fs.mkdir === fs.mkdir) {
		const pth = path.resolve(input);

		await mkdir(pth, {
			mode: options.mode,
			recursive: true
		});

		return pth;
	}

	const make = async pth => {
		try {
			await mkdir(pth, options.mode);

			return pth;
		} catch (error) {
			if (error.code === 'EPERM') {
				throw error;
			}

			if (error.code === 'ENOENT') {
				if (path.dirname(pth) === pth) {
					throw permissionError(pth);
				}

				if (error.message.includes('null bytes')) {
					throw error;
				}

				await make(path.dirname(pth));

				return make(pth);
			}

			try {
				const stats = await stat(pth);
				if (!stats.isDirectory()) {
					throw new Error('The path is not a directory');
				}
			} catch (_) {
				throw error;
			}

			return pth;
		}
	};

	return make(path.resolve(input));
};

module.exports = makeDir;

module.exports.sync = (input, options) => {
	checkPath(input);
	options = processOptions(options);

	if (useNativeRecursiveOption && options.fs.mkdirSync === fs.mkdirSync) {
		const pth = path.resolve(input);

		fs.mkdirSync(pth, {
			mode: options.mode,
			recursive: true
		});

		return pth;
	}

	const make = pth => {
		try {
			options.fs.mkdirSync(pth, options.mode);
		} catch (error) {
			if (error.code === 'EPERM') {
				throw error;
			}

			if (error.code === 'ENOENT') {
				if (path.dirname(pth) === pth) {
					throw permissionError(pth);
				}

				if (error.message.includes('null bytes')) {
					throw error;
				}

				make(path.dirname(pth));
				return make(pth);
			}

			try {
				if (!options.fs.statSync(pth).isDirectory()) {
					throw new Error('The path is not a directory');
				}
			} catch (_) {
				throw error;
			}
		}

		return pth;
	};

	return make(path.resolve(input));
};


/***/ }),

/***/ 4643:
/***/ ((module) => {

/*!
 * map-cache <https://github.com/jonschlinkert/map-cache>
 *
 * Copyright (c) 2015, Jon Schlinkert.
 * Licensed under the MIT License.
 */



var hasOwn = Object.prototype.hasOwnProperty;

/**
 * Expose `MapCache`
 */

module.exports = MapCache;

/**
 * Creates a cache object to store key/value pairs.
 *
 * ```js
 * var cache = new MapCache();
 * ```
 *
 * @api public
 */

function MapCache(data) {
  this.__data__ = data || {};
}

/**
 * Adds `value` to `key` on the cache.
 *
 * ```js
 * cache.set('foo', 'bar');
 * ```
 *
 * @param {String} `key` The key of the value to cache.
 * @param {*} `value` The value to cache.
 * @returns {Object} Returns the `Cache` object for chaining.
 * @api public
 */

MapCache.prototype.set = function mapSet(key, value) {
  if (key !== '__proto__') {
    this.__data__[key] = value;
  }
  return this;
};

/**
 * Gets the cached value for `key`.
 *
 * ```js
 * cache.get('foo');
 * //=> 'bar'
 * ```
 *
 * @param {String} `key` The key of the value to get.
 * @returns {*} Returns the cached value.
 * @api public
 */

MapCache.prototype.get = function mapGet(key) {
  return key === '__proto__' ? undefined : this.__data__[key];
};

/**
 * Checks if a cached value for `key` exists.
 *
 * ```js
 * cache.has('foo');
 * //=> true
 * ```
 *
 * @param {String} `key` The key of the entry to check.
 * @returns {Boolean} Returns `true` if an entry for `key` exists, else `false`.
 * @api public
 */

MapCache.prototype.has = function mapHas(key) {
  return key !== '__proto__' && hasOwn.call(this.__data__, key);
};

/**
 * Removes `key` and its value from the cache.
 *
 * ```js
 * cache.del('foo');
 * ```
 * @title .del
 * @param {String} `key` The key of the value to remove.
 * @returns {Boolean} Returns `true` if the entry was removed successfully, else `false`.
 * @api public
 */

MapCache.prototype.del = function mapDelete(key) {
  return this.has(key) && delete this.__data__[key];
};


/***/ }),

/***/ 2144:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var util = __nccwpck_require__(3837);
var visit = __nccwpck_require__(3178);

/**
 * Map `visit` over an array of objects.
 *
 * @param  {Object} `collection` The context in which to invoke `method`
 * @param  {String} `method` Name of the method to call on `collection`
 * @param  {Object} `arr` Array of objects.
 */

module.exports = function mapVisit(collection, method, val) {
  if (isObject(val)) {
    return visit.apply(null, arguments);
  }

  if (!Array.isArray(val)) {
    throw new TypeError('expected an array: ' + util.inspect(val));
  }

  var args = [].slice.call(arguments, 3);

  for (var i = 0; i < val.length; i++) {
    var ele = val[i];
    if (isObject(ele)) {
      visit.apply(null, [collection, method, ele].concat(args));
    } else {
      collection[method].apply(collection, [ele].concat(args));
    }
  }
};

function isObject(val) {
  return val && (typeof val === 'function' || (!Array.isArray(val) && typeof val === 'object'));
}


/***/ }),

/***/ 2578:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {


/*
 * merge2
 * https://github.com/teambition/merge2
 *
 * Copyright (c) 2014-2020 Teambition
 * Licensed under the MIT license.
 */
const Stream = __nccwpck_require__(2781)
const PassThrough = Stream.PassThrough
const slice = Array.prototype.slice

module.exports = merge2

function merge2 () {
  const streamsQueue = []
  const args = slice.call(arguments)
  let merging = false
  let options = args[args.length - 1]

  if (options && !Array.isArray(options) && options.pipe == null) {
    args.pop()
  } else {
    options = {}
  }

  const doEnd = options.end !== false
  const doPipeError = options.pipeError === true
  if (options.objectMode == null) {
    options.objectMode = true
  }
  if (options.highWaterMark == null) {
    options.highWaterMark = 64 * 1024
  }
  const mergedStream = PassThrough(options)

  function addStream () {
    for (let i = 0, len = arguments.length; i < len; i++) {
      streamsQueue.push(pauseStreams(arguments[i], options))
    }
    mergeStream()
    return this
  }

  function mergeStream () {
    if (merging) {
      return
    }
    merging = true

    let streams = streamsQueue.shift()
    if (!streams) {
      process.nextTick(endStream)
      return
    }
    if (!Array.isArray(streams)) {
      streams = [streams]
    }

    let pipesCount = streams.length + 1

    function next () {
      if (--pipesCount > 0) {
        return
      }
      merging = false
      mergeStream()
    }

    function pipe (stream) {
      function onend () {
        stream.removeListener('merge2UnpipeEnd', onend)
        stream.removeListener('end', onend)
        if (doPipeError) {
          stream.removeListener('error', onerror)
        }
        next()
      }
      function onerror (err) {
        mergedStream.emit('error', err)
      }
      // skip ended stream
      if (stream._readableState.endEmitted) {
        return next()
      }

      stream.on('merge2UnpipeEnd', onend)
      stream.on('end', onend)

      if (doPipeError) {
        stream.on('error', onerror)
      }

      stream.pipe(mergedStream, { end: false })
      // compatible for old stream
      stream.resume()
    }

    for (let i = 0; i < streams.length; i++) {
      pipe(streams[i])
    }

    next()
  }

  function endStream () {
    merging = false
    // emit 'queueDrain' when all streams merged.
    mergedStream.emit('queueDrain')
    if (doEnd) {
      mergedStream.end()
    }
  }

  mergedStream.setMaxListeners(0)
  mergedStream.add = addStream
  mergedStream.on('unpipe', function (stream) {
    stream.emit('merge2UnpipeEnd')
  })

  if (args.length) {
    addStream.apply(null, args)
  }
  return mergedStream
}

// check and pause streams for pipe.
function pauseStreams (streams, options) {
  if (!Array.isArray(streams)) {
    // Backwards-compat with old-style streams
    if (!streams._readableState && streams.pipe) {
      streams = streams.pipe(PassThrough(options))
    }
    if (!streams._readableState || !streams.pause || !streams.pipe) {
      throw new Error('Only readable stream can be merged.')
    }
    streams.pause()
  } else {
    for (let i = 0, len = streams.length; i < len; i++) {
      streams[i] = pauseStreams(streams[i], options)
    }
  }
  return streams
}


/***/ }),

/***/ 6228:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



/**
 * Module dependencies
 */

var util = __nccwpck_require__(3837);
var braces = __nccwpck_require__(610);
var toRegex = __nccwpck_require__(6855);
var extend = __nccwpck_require__(8710);

/**
 * Local dependencies
 */

var compilers = __nccwpck_require__(837);
var parsers = __nccwpck_require__(2057);
var cache = __nccwpck_require__(1145);
var utils = __nccwpck_require__(4713);
var MAX_LENGTH = 1024 * 64;

/**
 * The main function takes a list of strings and one or more
 * glob patterns to use for matching.
 *
 * ```js
 * var mm = require('micromatch');
 * mm(list, patterns[, options]);
 *
 * console.log(mm(['a.js', 'a.txt'], ['*.js']));
 * //=> [ 'a.js' ]
 * ```
 * @param {Array} `list` A list of strings to match
 * @param {String|Array} `patterns` One or more glob patterns to use for matching.
 * @param {Object} `options` See available [options](#options) for changing how matches are performed
 * @return {Array} Returns an array of matches
 * @summary false
 * @api public
 */

function micromatch(list, patterns, options) {
  patterns = utils.arrayify(patterns);
  list = utils.arrayify(list);

  var len = patterns.length;
  if (list.length === 0 || len === 0) {
    return [];
  }

  if (len === 1) {
    return micromatch.match(list, patterns[0], options);
  }

  var omit = [];
  var keep = [];
  var idx = -1;

  while (++idx < len) {
    var pattern = patterns[idx];

    if (typeof pattern === 'string' && pattern.charCodeAt(0) === 33 /* ! */) {
      omit.push.apply(omit, micromatch.match(list, pattern.slice(1), options));
    } else {
      keep.push.apply(keep, micromatch.match(list, pattern, options));
    }
  }

  var matches = utils.diff(keep, omit);
  if (!options || options.nodupes !== false) {
    return utils.unique(matches);
  }

  return matches;
}

/**
 * Similar to the main function, but `pattern` must be a string.
 *
 * ```js
 * var mm = require('micromatch');
 * mm.match(list, pattern[, options]);
 *
 * console.log(mm.match(['a.a', 'a.aa', 'a.b', 'a.c'], '*.a'));
 * //=> ['a.a', 'a.aa']
 * ```
 * @param {Array} `list` Array of strings to match
 * @param {String} `pattern` Glob pattern to use for matching.
 * @param {Object} `options` See available [options](#options) for changing how matches are performed
 * @return {Array} Returns an array of matches
 * @api public
 */

micromatch.match = function(list, pattern, options) {
  if (Array.isArray(pattern)) {
    throw new TypeError('expected pattern to be a string');
  }

  var unixify = utils.unixify(options);
  var isMatch = memoize('match', pattern, options, micromatch.matcher);
  var matches = [];

  list = utils.arrayify(list);
  var len = list.length;
  var idx = -1;

  while (++idx < len) {
    var ele = list[idx];
    if (ele === pattern || isMatch(ele)) {
      matches.push(utils.value(ele, unixify, options));
    }
  }

  // if no options were passed, uniquify results and return
  if (typeof options === 'undefined') {
    return utils.unique(matches);
  }

  if (matches.length === 0) {
    if (options.failglob === true) {
      throw new Error('no matches found for "' + pattern + '"');
    }
    if (options.nonull === true || options.nullglob === true) {
      return [options.unescape ? utils.unescape(pattern) : pattern];
    }
  }

  // if `opts.ignore` was defined, diff ignored list
  if (options.ignore) {
    matches = micromatch.not(matches, options.ignore, options);
  }

  return options.nodupes !== false ? utils.unique(matches) : matches;
};

/**
 * Returns true if the specified `string` matches the given glob `pattern`.
 *
 * ```js
 * var mm = require('micromatch');
 * mm.isMatch(string, pattern[, options]);
 *
 * console.log(mm.isMatch('a.a', '*.a'));
 * //=> true
 * console.log(mm.isMatch('a.b', '*.a'));
 * //=> false
 * ```
 * @param {String} `string` String to match
 * @param {String} `pattern` Glob pattern to use for matching.
 * @param {Object} `options` See available [options](#options) for changing how matches are performed
 * @return {Boolean} Returns true if the string matches the glob pattern.
 * @api public
 */

micromatch.isMatch = function(str, pattern, options) {
  if (typeof str !== 'string') {
    throw new TypeError('expected a string: "' + util.inspect(str) + '"');
  }

  if (isEmptyString(str) || isEmptyString(pattern)) {
    return false;
  }

  var equals = utils.equalsPattern(options);
  if (equals(str)) {
    return true;
  }

  var isMatch = memoize('isMatch', pattern, options, micromatch.matcher);
  return isMatch(str);
};

/**
 * Returns true if some of the strings in the given `list` match any of the
 * given glob `patterns`.
 *
 * ```js
 * var mm = require('micromatch');
 * mm.some(list, patterns[, options]);
 *
 * console.log(mm.some(['foo.js', 'bar.js'], ['*.js', '!foo.js']));
 * // true
 * console.log(mm.some(['foo.js'], ['*.js', '!foo.js']));
 * // false
 * ```
 * @param  {String|Array} `list` The string or array of strings to test. Returns as soon as the first match is found.
 * @param {String|Array} `patterns` One or more glob patterns to use for matching.
 * @param {Object} `options` See available [options](#options) for changing how matches are performed
 * @return {Boolean} Returns true if any patterns match `str`
 * @api public
 */

micromatch.some = function(list, patterns, options) {
  if (typeof list === 'string') {
    list = [list];
  }
  for (var i = 0; i < list.length; i++) {
    if (micromatch(list[i], patterns, options).length === 1) {
      return true;
    }
  }
  return false;
};

/**
 * Returns true if every string in the given `list` matches
 * any of the given glob `patterns`.
 *
 * ```js
 * var mm = require('micromatch');
 * mm.every(list, patterns[, options]);
 *
 * console.log(mm.every('foo.js', ['foo.js']));
 * // true
 * console.log(mm.every(['foo.js', 'bar.js'], ['*.js']));
 * // true
 * console.log(mm.every(['foo.js', 'bar.js'], ['*.js', '!foo.js']));
 * // false
 * console.log(mm.every(['foo.js'], ['*.js', '!foo.js']));
 * // false
 * ```
 * @param  {String|Array} `list` The string or array of strings to test.
 * @param {String|Array} `patterns` One or more glob patterns to use for matching.
 * @param {Object} `options` See available [options](#options) for changing how matches are performed
 * @return {Boolean} Returns true if any patterns match `str`
 * @api public
 */

micromatch.every = function(list, patterns, options) {
  if (typeof list === 'string') {
    list = [list];
  }
  for (var i = 0; i < list.length; i++) {
    if (micromatch(list[i], patterns, options).length !== 1) {
      return false;
    }
  }
  return true;
};

/**
 * Returns true if **any** of the given glob `patterns`
 * match the specified `string`.
 *
 * ```js
 * var mm = require('micromatch');
 * mm.any(string, patterns[, options]);
 *
 * console.log(mm.any('a.a', ['b.*', '*.a']));
 * //=> true
 * console.log(mm.any('a.a', 'b.*'));
 * //=> false
 * ```
 * @param  {String|Array} `str` The string to test.
 * @param {String|Array} `patterns` One or more glob patterns to use for matching.
 * @param {Object} `options` See available [options](#options) for changing how matches are performed
 * @return {Boolean} Returns true if any patterns match `str`
 * @api public
 */

micromatch.any = function(str, patterns, options) {
  if (typeof str !== 'string') {
    throw new TypeError('expected a string: "' + util.inspect(str) + '"');
  }

  if (isEmptyString(str) || isEmptyString(patterns)) {
    return false;
  }

  if (typeof patterns === 'string') {
    patterns = [patterns];
  }

  for (var i = 0; i < patterns.length; i++) {
    if (micromatch.isMatch(str, patterns[i], options)) {
      return true;
    }
  }
  return false;
};

/**
 * Returns true if **all** of the given `patterns` match
 * the specified string.
 *
 * ```js
 * var mm = require('micromatch');
 * mm.all(string, patterns[, options]);
 *
 * console.log(mm.all('foo.js', ['foo.js']));
 * // true
 *
 * console.log(mm.all('foo.js', ['*.js', '!foo.js']));
 * // false
 *
 * console.log(mm.all('foo.js', ['*.js', 'foo.js']));
 * // true
 *
 * console.log(mm.all('foo.js', ['*.js', 'f*', '*o*', '*o.js']));
 * // true
 * ```
 * @param  {String|Array} `str` The string to test.
 * @param {String|Array} `patterns` One or more glob patterns to use for matching.
 * @param {Object} `options` See available [options](#options) for changing how matches are performed
 * @return {Boolean} Returns true if any patterns match `str`
 * @api public
 */

micromatch.all = function(str, patterns, options) {
  if (typeof str !== 'string') {
    throw new TypeError('expected a string: "' + util.inspect(str) + '"');
  }
  if (typeof patterns === 'string') {
    patterns = [patterns];
  }
  for (var i = 0; i < patterns.length; i++) {
    if (!micromatch.isMatch(str, patterns[i], options)) {
      return false;
    }
  }
  return true;
};

/**
 * Returns a list of strings that _**do not match any**_ of the given `patterns`.
 *
 * ```js
 * var mm = require('micromatch');
 * mm.not(list, patterns[, options]);
 *
 * console.log(mm.not(['a.a', 'b.b', 'c.c'], '*.a'));
 * //=> ['b.b', 'c.c']
 * ```
 * @param {Array} `list` Array of strings to match.
 * @param {String|Array} `patterns` One or more glob pattern to use for matching.
 * @param {Object} `options` See available [options](#options) for changing how matches are performed
 * @return {Array} Returns an array of strings that **do not match** the given patterns.
 * @api public
 */

micromatch.not = function(list, patterns, options) {
  var opts = extend({}, options);
  var ignore = opts.ignore;
  delete opts.ignore;

  var unixify = utils.unixify(opts);
  list = utils.arrayify(list).map(unixify);

  var matches = utils.diff(list, micromatch(list, patterns, opts));
  if (ignore) {
    matches = utils.diff(matches, micromatch(list, ignore));
  }

  return opts.nodupes !== false ? utils.unique(matches) : matches;
};

/**
 * Returns true if the given `string` contains the given pattern. Similar
 * to [.isMatch](#isMatch) but the pattern can match any part of the string.
 *
 * ```js
 * var mm = require('micromatch');
 * mm.contains(string, pattern[, options]);
 *
 * console.log(mm.contains('aa/bb/cc', '*b'));
 * //=> true
 * console.log(mm.contains('aa/bb/cc', '*d'));
 * //=> false
 * ```
 * @param {String} `str` The string to match.
 * @param {String|Array} `patterns` Glob pattern to use for matching.
 * @param {Object} `options` See available [options](#options) for changing how matches are performed
 * @return {Boolean} Returns true if the patter matches any part of `str`.
 * @api public
 */

micromatch.contains = function(str, patterns, options) {
  if (typeof str !== 'string') {
    throw new TypeError('expected a string: "' + util.inspect(str) + '"');
  }

  if (typeof patterns === 'string') {
    if (isEmptyString(str) || isEmptyString(patterns)) {
      return false;
    }

    var equals = utils.equalsPattern(patterns, options);
    if (equals(str)) {
      return true;
    }
    var contains = utils.containsPattern(patterns, options);
    if (contains(str)) {
      return true;
    }
  }

  var opts = extend({}, options, {contains: true});
  return micromatch.any(str, patterns, opts);
};

/**
 * Returns true if the given pattern and options should enable
 * the `matchBase` option.
 * @return {Boolean}
 * @api private
 */

micromatch.matchBase = function(pattern, options) {
  if (pattern && pattern.indexOf('/') !== -1 || !options) return false;
  return options.basename === true || options.matchBase === true;
};

/**
 * Filter the keys of the given object with the given `glob` pattern
 * and `options`. Does not attempt to match nested keys. If you need this feature,
 * use [glob-object][] instead.
 *
 * ```js
 * var mm = require('micromatch');
 * mm.matchKeys(object, patterns[, options]);
 *
 * var obj = { aa: 'a', ab: 'b', ac: 'c' };
 * console.log(mm.matchKeys(obj, '*b'));
 * //=> { ab: 'b' }
 * ```
 * @param {Object} `object` The object with keys to filter.
 * @param {String|Array} `patterns` One or more glob patterns to use for matching.
 * @param {Object} `options` See available [options](#options) for changing how matches are performed
 * @return {Object} Returns an object with only keys that match the given patterns.
 * @api public
 */

micromatch.matchKeys = function(obj, patterns, options) {
  if (!utils.isObject(obj)) {
    throw new TypeError('expected the first argument to be an object');
  }
  var keys = micromatch(Object.keys(obj), patterns, options);
  return utils.pick(obj, keys);
};

/**
 * Returns a memoized matcher function from the given glob `pattern` and `options`.
 * The returned function takes a string to match as its only argument and returns
 * true if the string is a match.
 *
 * ```js
 * var mm = require('micromatch');
 * mm.matcher(pattern[, options]);
 *
 * var isMatch = mm.matcher('*.!(*a)');
 * console.log(isMatch('a.a'));
 * //=> false
 * console.log(isMatch('a.b'));
 * //=> true
 * ```
 * @param {String} `pattern` Glob pattern
 * @param {Object} `options` See available [options](#options) for changing how matches are performed.
 * @return {Function} Returns a matcher function.
 * @api public
 */

micromatch.matcher = function matcher(pattern, options) {
  if (Array.isArray(pattern)) {
    return compose(pattern, options, matcher);
  }

  // if pattern is a regex
  if (pattern instanceof RegExp) {
    return test(pattern);
  }

  // if pattern is invalid
  if (!utils.isString(pattern)) {
    throw new TypeError('expected pattern to be an array, string or regex');
  }

  // if pattern is a non-glob string
  if (!utils.hasSpecialChars(pattern)) {
    if (options && options.nocase === true) {
      pattern = pattern.toLowerCase();
    }
    return utils.matchPath(pattern, options);
  }

  // if pattern is a glob string
  var re = micromatch.makeRe(pattern, options);

  // if `options.matchBase` or `options.basename` is defined
  if (micromatch.matchBase(pattern, options)) {
    return utils.matchBasename(re, options);
  }

  function test(regex) {
    var equals = utils.equalsPattern(options);
    var unixify = utils.unixify(options);

    return function(str) {
      if (equals(str)) {
        return true;
      }

      if (regex.test(unixify(str))) {
        return true;
      }
      return false;
    };
  }

  var fn = test(re);
  Object.defineProperty(fn, 'result', {
    configurable: true,
    enumerable: false,
    value: re.result
  });
  return fn;
};

/**
 * Returns an array of matches captured by `pattern` in `string, or `null` if the pattern did not match.
 *
 * ```js
 * var mm = require('micromatch');
 * mm.capture(pattern, string[, options]);
 *
 * console.log(mm.capture('test/*.js', 'test/foo.js'));
 * //=> ['foo']
 * console.log(mm.capture('test/*.js', 'foo/bar.css'));
 * //=> null
 * ```
 * @param {String} `pattern` Glob pattern to use for matching.
 * @param {String} `string` String to match
 * @param {Object} `options` See available [options](#options) for changing how matches are performed
 * @return {Boolean} Returns an array of captures if the string matches the glob pattern, otherwise `null`.
 * @api public
 */

micromatch.capture = function(pattern, str, options) {
  var re = micromatch.makeRe(pattern, extend({capture: true}, options));
  var unixify = utils.unixify(options);

  function match() {
    return function(string) {
      var match = re.exec(unixify(string));
      if (!match) {
        return null;
      }

      return match.slice(1);
    };
  }

  var capture = memoize('capture', pattern, options, match);
  return capture(str);
};

/**
 * Create a regular expression from the given glob `pattern`.
 *
 * ```js
 * var mm = require('micromatch');
 * mm.makeRe(pattern[, options]);
 *
 * console.log(mm.makeRe('*.js'));
 * //=> /^(?:(\.[\\\/])?(?!\.)(?=.)[^\/]*?\.js)$/
 * ```
 * @param {String} `pattern` A glob pattern to convert to regex.
 * @param {Object} `options` See available [options](#options) for changing how matches are performed.
 * @return {RegExp} Returns a regex created from the given pattern.
 * @api public
 */

micromatch.makeRe = function(pattern, options) {
  if (typeof pattern !== 'string') {
    throw new TypeError('expected pattern to be a string');
  }

  if (pattern.length > MAX_LENGTH) {
    throw new Error('expected pattern to be less than ' + MAX_LENGTH + ' characters');
  }

  function makeRe() {
    var result = micromatch.create(pattern, options);
    var ast_array = [];
    var output = result.map(function(obj) {
      obj.ast.state = obj.state;
      ast_array.push(obj.ast);
      return obj.output;
    });

    var regex = toRegex(output.join('|'), options);
    Object.defineProperty(regex, 'result', {
      configurable: true,
      enumerable: false,
      value: ast_array
    });
    return regex;
  }

  return memoize('makeRe', pattern, options, makeRe);
};

/**
 * Expand the given brace `pattern`.
 *
 * ```js
 * var mm = require('micromatch');
 * console.log(mm.braces('foo/{a,b}/bar'));
 * //=> ['foo/(a|b)/bar']
 *
 * console.log(mm.braces('foo/{a,b}/bar', {expand: true}));
 * //=> ['foo/(a|b)/bar']
 * ```
 * @param {String} `pattern` String with brace pattern to expand.
 * @param {Object} `options` Any [options](#options) to change how expansion is performed. See the [braces][] library for all available options.
 * @return {Array}
 * @api public
 */

micromatch.braces = function(pattern, options) {
  if (typeof pattern !== 'string' && !Array.isArray(pattern)) {
    throw new TypeError('expected pattern to be an array or string');
  }

  function expand() {
    if (options && options.nobrace === true || !/\{.*\}/.test(pattern)) {
      return utils.arrayify(pattern);
    }
    return braces(pattern, options);
  }

  return memoize('braces', pattern, options, expand);
};

/**
 * Proxy to the [micromatch.braces](#method), for parity with
 * minimatch.
 */

micromatch.braceExpand = function(pattern, options) {
  var opts = extend({}, options, {expand: true});
  return micromatch.braces(pattern, opts);
};

/**
 * Parses the given glob `pattern` and returns an array of abstract syntax
 * trees (ASTs), with the compiled `output` and optional source `map` on
 * each AST.
 *
 * ```js
 * var mm = require('micromatch');
 * mm.create(pattern[, options]);
 *
 * console.log(mm.create('abc/*.js'));
 * // [{ options: { source: 'string', sourcemap: true },
 * //   state: {},
 * //   compilers:
 * //    { ... },
 * //   output: '(\\.[\\\\\\/])?abc\\/(?!\\.)(?=.)[^\\/]*?\\.js',
 * //   ast:
 * //    { type: 'root',
 * //      errors: [],
 * //      nodes:
 * //       [ ... ],
 * //      dot: false,
 * //      input: 'abc/*.js' },
 * //   parsingErrors: [],
 * //   map:
 * //    { version: 3,
 * //      sources: [ 'string' ],
 * //      names: [],
 * //      mappings: 'AAAA,GAAG,EAAC,kBAAC,EAAC,EAAE',
 * //      sourcesContent: [ 'abc/*.js' ] },
 * //   position: { line: 1, column: 28 },
 * //   content: {},
 * //   files: {},
 * //   idx: 6 }]
 * ```
 * @param {String} `pattern` Glob pattern to parse and compile.
 * @param {Object} `options` Any [options](#options) to change how parsing and compiling is performed.
 * @return {Object} Returns an object with the parsed AST, compiled string and optional source map.
 * @api public
 */

micromatch.create = function(pattern, options) {
  return memoize('create', pattern, options, function() {
    function create(str, opts) {
      return micromatch.compile(micromatch.parse(str, opts), opts);
    }

    pattern = micromatch.braces(pattern, options);
    var len = pattern.length;
    var idx = -1;
    var res = [];

    while (++idx < len) {
      res.push(create(pattern[idx], options));
    }
    return res;
  });
};

/**
 * Parse the given `str` with the given `options`.
 *
 * ```js
 * var mm = require('micromatch');
 * mm.parse(pattern[, options]);
 *
 * var ast = mm.parse('a/{b,c}/d');
 * console.log(ast);
 * // { type: 'root',
 * //   errors: [],
 * //   input: 'a/{b,c}/d',
 * //   nodes:
 * //    [ { type: 'bos', val: '' },
 * //      { type: 'text', val: 'a/' },
 * //      { type: 'brace',
 * //        nodes:
 * //         [ { type: 'brace.open', val: '{' },
 * //           { type: 'text', val: 'b,c' },
 * //           { type: 'brace.close', val: '}' } ] },
 * //      { type: 'text', val: '/d' },
 * //      { type: 'eos', val: '' } ] }
 * ```
 * @param {String} `str`
 * @param {Object} `options`
 * @return {Object} Returns an AST
 * @api public
 */

micromatch.parse = function(pattern, options) {
  if (typeof pattern !== 'string') {
    throw new TypeError('expected a string');
  }

  function parse() {
    var snapdragon = utils.instantiate(null, options);
    parsers(snapdragon, options);

    var ast = snapdragon.parse(pattern, options);
    utils.define(ast, 'snapdragon', snapdragon);
    ast.input = pattern;
    return ast;
  }

  return memoize('parse', pattern, options, parse);
};

/**
 * Compile the given `ast` or string with the given `options`.
 *
 * ```js
 * var mm = require('micromatch');
 * mm.compile(ast[, options]);
 *
 * var ast = mm.parse('a/{b,c}/d');
 * console.log(mm.compile(ast));
 * // { options: { source: 'string' },
 * //   state: {},
 * //   compilers:
 * //    { eos: [Function],
 * //      noop: [Function],
 * //      bos: [Function],
 * //      brace: [Function],
 * //      'brace.open': [Function],
 * //      text: [Function],
 * //      'brace.close': [Function] },
 * //   output: [ 'a/(b|c)/d' ],
 * //   ast:
 * //    { ... },
 * //   parsingErrors: [] }
 * ```
 * @param {Object|String} `ast`
 * @param {Object} `options`
 * @return {Object} Returns an object that has an `output` property with the compiled string.
 * @api public
 */

micromatch.compile = function(ast, options) {
  if (typeof ast === 'string') {
    ast = micromatch.parse(ast, options);
  }

  return memoize('compile', ast.input, options, function() {
    var snapdragon = utils.instantiate(ast, options);
    compilers(snapdragon, options);
    return snapdragon.compile(ast, options);
  });
};

/**
 * Clear the regex cache.
 *
 * ```js
 * mm.clearCache();
 * ```
 * @api public
 */

micromatch.clearCache = function() {
  micromatch.cache.caches = {};
};

/**
 * Returns true if the given value is effectively an empty string
 */

function isEmptyString(val) {
  return String(val) === '' || String(val) === './';
}

/**
 * Compose a matcher function with the given patterns.
 * This allows matcher functions to be compiled once and
 * called multiple times.
 */

function compose(patterns, options, matcher) {
  var matchers;

  return memoize('compose', String(patterns), options, function() {
    return function(file) {
      // delay composition until it's invoked the first time,
      // after that it won't be called again
      if (!matchers) {
        matchers = [];
        for (var i = 0; i < patterns.length; i++) {
          matchers.push(matcher(patterns[i], options));
        }
      }

      var len = matchers.length;
      while (len--) {
        if (matchers[len](file) === true) {
          return true;
        }
      }
      return false;
    };
  });
}

/**
 * Memoize a generated regex or function. A unique key is generated
 * from the `type` (usually method name), the `pattern`, and
 * user-defined options.
 */

function memoize(type, pattern, options, fn) {
  var key = utils.createKey(type + '=' + pattern, options);

  if (options && options.cache === false) {
    return fn(pattern, options);
  }

  if (cache.has(type, key)) {
    return cache.get(type, key);
  }

  var val = fn(pattern, options);
  cache.set(type, key, val);
  return val;
}

/**
 * Expose compiler, parser and cache on `micromatch`
 */

micromatch.compilers = compilers;
micromatch.parsers = parsers;
micromatch.caches = cache.caches;

/**
 * Expose `micromatch`
 * @type {Function}
 */

module.exports = micromatch;


/***/ }),

/***/ 1145:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

module.exports = new (__nccwpck_require__(4838))();


/***/ }),

/***/ 837:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var nanomatch = __nccwpck_require__(2316);
var extglob = __nccwpck_require__(2129);

module.exports = function(snapdragon) {
  var compilers = snapdragon.compiler.compilers;
  var opts = snapdragon.options;

  // register nanomatch compilers
  snapdragon.use(nanomatch.compilers);

  // get references to some specific nanomatch compilers before they
  // are overridden by the extglob and/or custom compilers
  var escape = compilers.escape;
  var qmark = compilers.qmark;
  var slash = compilers.slash;
  var star = compilers.star;
  var text = compilers.text;
  var plus = compilers.plus;
  var dot = compilers.dot;

  // register extglob compilers or escape exglobs if disabled
  if (opts.extglob === false || opts.noext === true) {
    snapdragon.compiler.use(escapeExtglobs);
  } else {
    snapdragon.use(extglob.compilers);
  }

  snapdragon.use(function() {
    this.options.star = this.options.star || function(/*node*/) {
      return '[^\\\\/]*?';
    };
  });

  // custom micromatch compilers
  snapdragon.compiler

    // reset referenced compiler
    .set('dot', dot)
    .set('escape', escape)
    .set('plus', plus)
    .set('slash', slash)
    .set('qmark', qmark)
    .set('star', star)
    .set('text', text);
};

function escapeExtglobs(compiler) {
  compiler.set('paren', function(node) {
    var val = '';
    visit(node, function(tok) {
      if (tok.val) val += (/^\W/.test(tok.val) ? '\\' : '') + tok.val;
    });
    return this.emit(val, node);
  });

  /**
   * Visit `node` with the given `fn`
   */

  function visit(node, fn) {
    return node.nodes ? mapVisit(node.nodes, fn) : fn(node);
  }

  /**
   * Map visit over array of `nodes`.
   */

  function mapVisit(nodes, fn) {
    var len = nodes.length;
    var idx = -1;
    while (++idx < len) {
      visit(nodes[idx], fn);
    }
  }
}


/***/ }),

/***/ 2057:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var extglob = __nccwpck_require__(2129);
var nanomatch = __nccwpck_require__(2316);
var regexNot = __nccwpck_require__(2527);
var toRegex = __nccwpck_require__(6855);
var not;

/**
 * Characters to use in negation regex (we want to "not" match
 * characters that are matched by other parsers)
 */

var TEXT = '([!@*?+]?\\(|\\)|\\[:?(?=.*?:?\\])|:?\\]|[*+?!^$.\\\\/])+';
var createNotRegex = function(opts) {
  return not || (not = textRegex(TEXT));
};

/**
 * Parsers
 */

module.exports = function(snapdragon) {
  var parsers = snapdragon.parser.parsers;

  // register nanomatch parsers
  snapdragon.use(nanomatch.parsers);

  // get references to some specific nanomatch parsers before they
  // are overridden by the extglob and/or parsers
  var escape = parsers.escape;
  var slash = parsers.slash;
  var qmark = parsers.qmark;
  var plus = parsers.plus;
  var star = parsers.star;
  var dot = parsers.dot;

  // register extglob parsers
  snapdragon.use(extglob.parsers);

  // custom micromatch parsers
  snapdragon.parser
    .use(function() {
      // override "notRegex" created in nanomatch parser
      this.notRegex = /^\!+(?!\()/;
    })
    // reset the referenced parsers
    .capture('escape', escape)
    .capture('slash', slash)
    .capture('qmark', qmark)
    .capture('star', star)
    .capture('plus', plus)
    .capture('dot', dot)

    /**
     * Override `text` parser
     */

    .capture('text', function() {
      if (this.isInside('bracket')) return;
      var pos = this.position();
      var m = this.match(createNotRegex(this.options));
      if (!m || !m[0]) return;

      // escape regex boundary characters and simple brackets
      var val = m[0].replace(/([[\]^$])/g, '\\$1');

      return pos({
        type: 'text',
        val: val
      });
    });
};

/**
 * Create text regex
 */

function textRegex(pattern) {
  var notStr = regexNot.create(pattern, {contains: true, strictClose: false});
  var prefix = '(?:[\\^]|\\\\|';
  return toRegex(prefix + notStr + ')', {strictClose: false});
}


/***/ }),

/***/ 4713:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var utils = module.exports;
var path = __nccwpck_require__(1017);

/**
 * Module dependencies
 */

var Snapdragon = __nccwpck_require__(2403);
utils.define = __nccwpck_require__(2209);
utils.diff = __nccwpck_require__(8915);
utils.extend = __nccwpck_require__(8710);
utils.pick = __nccwpck_require__(9962);
utils.typeOf = __nccwpck_require__(7577);
utils.unique = __nccwpck_require__(340);

/**
 * Returns true if the platform is windows, or `path.sep` is `\\`.
 * This is defined as a function to allow `path.sep` to be set in unit tests,
 * or by the user, if there is a reason to do so.
 * @return {Boolean}
 */

utils.isWindows = function() {
  return path.sep === '\\' || process.platform === 'win32';
};

/**
 * Get the `Snapdragon` instance to use
 */

utils.instantiate = function(ast, options) {
  var snapdragon;
  // if an instance was created by `.parse`, use that instance
  if (utils.typeOf(ast) === 'object' && ast.snapdragon) {
    snapdragon = ast.snapdragon;
  // if the user supplies an instance on options, use that instance
  } else if (utils.typeOf(options) === 'object' && options.snapdragon) {
    snapdragon = options.snapdragon;
  // create a new instance
  } else {
    snapdragon = new Snapdragon(options);
  }

  utils.define(snapdragon, 'parse', function(str, options) {
    var parsed = Snapdragon.prototype.parse.apply(this, arguments);
    parsed.input = str;

    // escape unmatched brace/bracket/parens
    var last = this.parser.stack.pop();
    if (last && this.options.strictErrors !== true) {
      var open = last.nodes[0];
      var inner = last.nodes[1];
      if (last.type === 'bracket') {
        if (inner.val.charAt(0) === '[') {
          inner.val = '\\' + inner.val;
        }

      } else {
        open.val = '\\' + open.val;
        var sibling = open.parent.nodes[1];
        if (sibling.type === 'star') {
          sibling.loose = true;
        }
      }
    }

    // add non-enumerable parser reference
    utils.define(parsed, 'parser', this.parser);
    return parsed;
  });

  return snapdragon;
};

/**
 * Create the key to use for memoization. The key is generated
 * by iterating over the options and concatenating key-value pairs
 * to the pattern string.
 */

utils.createKey = function(pattern, options) {
  if (utils.typeOf(options) !== 'object') {
    return pattern;
  }
  var val = pattern;
  var keys = Object.keys(options);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    val += ';' + key + '=' + String(options[key]);
  }
  return val;
};

/**
 * Cast `val` to an array
 * @return {Array}
 */

utils.arrayify = function(val) {
  if (typeof val === 'string') return [val];
  return val ? (Array.isArray(val) ? val : [val]) : [];
};

/**
 * Return true if `val` is a non-empty string
 */

utils.isString = function(val) {
  return typeof val === 'string';
};

/**
 * Return true if `val` is a non-empty string
 */

utils.isObject = function(val) {
  return utils.typeOf(val) === 'object';
};

/**
 * Returns true if the given `str` has special characters
 */

utils.hasSpecialChars = function(str) {
  return /(?:(?:(^|\/)[!.])|[*?+()|\[\]{}]|[+@]\()/.test(str);
};

/**
 * Escape regex characters in the given string
 */

utils.escapeRegex = function(str) {
  return str.replace(/[-[\]{}()^$|*+?.\\\/\s]/g, '\\$&');
};

/**
 * Normalize slashes in the given filepath.
 *
 * @param {String} `filepath`
 * @return {String}
 */

utils.toPosixPath = function(str) {
  return str.replace(/\\+/g, '/');
};

/**
 * Strip backslashes before special characters in a string.
 *
 * @param {String} `str`
 * @return {String}
 */

utils.unescape = function(str) {
  return utils.toPosixPath(str.replace(/\\(?=[*+?!.])/g, ''));
};

/**
 * Strip the prefix from a filepath
 * @param {String} `fp`
 * @return {String}
 */

utils.stripPrefix = function(str) {
  if (str.charAt(0) !== '.') {
    return str;
  }
  var ch = str.charAt(1);
  if (utils.isSlash(ch)) {
    return str.slice(2);
  }
  return str;
};

/**
 * Returns true if the given str is an escaped or
 * unescaped path character
 */

utils.isSlash = function(str) {
  return str === '/' || str === '\\/' || str === '\\' || str === '\\\\';
};

/**
 * Returns a function that returns true if the given
 * pattern matches or contains a `filepath`
 *
 * @param {String} `pattern`
 * @return {Function}
 */

utils.matchPath = function(pattern, options) {
  return (options && options.contains)
    ? utils.containsPattern(pattern, options)
    : utils.equalsPattern(pattern, options);
};

/**
 * Returns true if the given (original) filepath or unixified path are equal
 * to the given pattern.
 */

utils._equals = function(filepath, unixPath, pattern) {
  return pattern === filepath || pattern === unixPath;
};

/**
 * Returns true if the given (original) filepath or unixified path contain
 * the given pattern.
 */

utils._contains = function(filepath, unixPath, pattern) {
  return filepath.indexOf(pattern) !== -1 || unixPath.indexOf(pattern) !== -1;
};

/**
 * Returns a function that returns true if the given
 * pattern is the same as a given `filepath`
 *
 * @param {String} `pattern`
 * @return {Function}
 */

utils.equalsPattern = function(pattern, options) {
  var unixify = utils.unixify(options);
  options = options || {};

  return function fn(filepath) {
    var equal = utils._equals(filepath, unixify(filepath), pattern);
    if (equal === true || options.nocase !== true) {
      return equal;
    }
    var lower = filepath.toLowerCase();
    return utils._equals(lower, unixify(lower), pattern);
  };
};

/**
 * Returns a function that returns true if the given
 * pattern contains a `filepath`
 *
 * @param {String} `pattern`
 * @return {Function}
 */

utils.containsPattern = function(pattern, options) {
  var unixify = utils.unixify(options);
  options = options || {};

  return function(filepath) {
    var contains = utils._contains(filepath, unixify(filepath), pattern);
    if (contains === true || options.nocase !== true) {
      return contains;
    }
    var lower = filepath.toLowerCase();
    return utils._contains(lower, unixify(lower), pattern);
  };
};

/**
 * Returns a function that returns true if the given
 * regex matches the `filename` of a file path.
 *
 * @param {RegExp} `re` Matching regex
 * @return {Function}
 */

utils.matchBasename = function(re) {
  return function(filepath) {
    return re.test(path.basename(filepath));
  };
};

/**
 * Determines the filepath to return based on the provided options.
 * @return {any}
 */

utils.value = function(str, unixify, options) {
  if (options && options.unixify === false) {
    return str;
  }
  return unixify(str);
};

/**
 * Returns a function that normalizes slashes in a string to forward
 * slashes, strips `./` from beginning of paths, and optionally unescapes
 * special characters.
 * @return {Function}
 */

utils.unixify = function(options) {
  options = options || {};
  return function(filepath) {
    if (utils.isWindows() || options.unixify === true) {
      filepath = utils.toPosixPath(filepath);
    }
    if (options.stripPrefix !== false) {
      filepath = utils.stripPrefix(filepath);
    }
    if (options.unescape === true) {
      filepath = utils.unescape(filepath);
    }
    return filepath;
  };
};


/***/ }),

/***/ 2209:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * define-property <https://github.com/jonschlinkert/define-property>
 *
 * Copyright (c) 2015-2018, Jon Schlinkert.
 * Released under the MIT License.
 */



var isobject = __nccwpck_require__(5509);
var isDescriptor = __nccwpck_require__(567);
var define = (typeof Reflect !== 'undefined' && Reflect.defineProperty)
  ? Reflect.defineProperty
  : Object.defineProperty;

module.exports = function defineProperty(obj, key, val) {
  if (!isobject(obj) && typeof obj !== 'function' && !Array.isArray(obj)) {
    throw new TypeError('expected an object, function, or array');
  }

  if (typeof key !== 'string') {
    throw new TypeError('expected "key" to be a string');
  }

  if (isDescriptor(val)) {
    define(obj, key, val);
    return obj;
  }

  define(obj, key, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: val
  });

  return obj;
};


/***/ }),

/***/ 8710:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var isExtendable = __nccwpck_require__(6007);
var assignSymbols = __nccwpck_require__(8782);

module.exports = Object.assign || function(obj/*, objects*/) {
  if (obj === null || typeof obj === 'undefined') {
    throw new TypeError('Cannot convert undefined or null to object');
  }
  if (!isObject(obj)) {
    obj = {};
  }
  for (var i = 1; i < arguments.length; i++) {
    var val = arguments[i];
    if (isString(val)) {
      val = toObject(val);
    }
    if (isObject(val)) {
      assign(obj, val);
      assignSymbols(obj, val);
    }
  }
  return obj;
};

function assign(a, b) {
  for (var key in b) {
    if (hasOwn(b, key)) {
      a[key] = b[key];
    }
  }
}

function isString(val) {
  return (val && typeof val === 'string');
}

function toObject(str) {
  var obj = {};
  for (var i in str) {
    obj[i] = str[i];
  }
  return obj;
}

function isObject(val) {
  return (val && typeof val === 'object') || isExtendable(val);
}

/**
 * Returns true if the given `key` is an own property of `obj`.
 */

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isEnum(obj, key) {
  return Object.prototype.propertyIsEnumerable.call(obj, key);
}


/***/ }),

/***/ 6007:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * is-extendable <https://github.com/jonschlinkert/is-extendable>
 *
 * Copyright (c) 2015-2017, Jon Schlinkert.
 * Released under the MIT License.
 */



var isPlainObject = __nccwpck_require__(7810);

module.exports = function isExtendable(val) {
  return isPlainObject(val) || typeof val === 'function' || Array.isArray(val);
};


/***/ }),

/***/ 7577:
/***/ ((module) => {

var toString = Object.prototype.toString;

module.exports = function kindOf(val) {
  if (val === void 0) return 'undefined';
  if (val === null) return 'null';

  var type = typeof val;
  if (type === 'boolean') return 'boolean';
  if (type === 'string') return 'string';
  if (type === 'number') return 'number';
  if (type === 'symbol') return 'symbol';
  if (type === 'function') {
    return isGeneratorFn(val) ? 'generatorfunction' : 'function';
  }

  if (isArray(val)) return 'array';
  if (isBuffer(val)) return 'buffer';
  if (isArguments(val)) return 'arguments';
  if (isDate(val)) return 'date';
  if (isError(val)) return 'error';
  if (isRegexp(val)) return 'regexp';

  switch (ctorName(val)) {
    case 'Symbol': return 'symbol';
    case 'Promise': return 'promise';

    // Set, Map, WeakSet, WeakMap
    case 'WeakMap': return 'weakmap';
    case 'WeakSet': return 'weakset';
    case 'Map': return 'map';
    case 'Set': return 'set';

    // 8-bit typed arrays
    case 'Int8Array': return 'int8array';
    case 'Uint8Array': return 'uint8array';
    case 'Uint8ClampedArray': return 'uint8clampedarray';

    // 16-bit typed arrays
    case 'Int16Array': return 'int16array';
    case 'Uint16Array': return 'uint16array';

    // 32-bit typed arrays
    case 'Int32Array': return 'int32array';
    case 'Uint32Array': return 'uint32array';
    case 'Float32Array': return 'float32array';
    case 'Float64Array': return 'float64array';
  }

  if (isGeneratorObj(val)) {
    return 'generator';
  }

  // Non-plain objects
  type = toString.call(val);
  switch (type) {
    case '[object Object]': return 'object';
    // iterators
    case '[object Map Iterator]': return 'mapiterator';
    case '[object Set Iterator]': return 'setiterator';
    case '[object String Iterator]': return 'stringiterator';
    case '[object Array Iterator]': return 'arrayiterator';
  }

  // other
  return type.slice(8, -1).toLowerCase().replace(/\s/g, '');
};

function ctorName(val) {
  return typeof val.constructor === 'function' ? val.constructor.name : null;
}

function isArray(val) {
  if (Array.isArray) return Array.isArray(val);
  return val instanceof Array;
}

function isError(val) {
  return val instanceof Error || (typeof val.message === 'string' && val.constructor && typeof val.constructor.stackTraceLimit === 'number');
}

function isDate(val) {
  if (val instanceof Date) return true;
  return typeof val.toDateString === 'function'
    && typeof val.getDate === 'function'
    && typeof val.setDate === 'function';
}

function isRegexp(val) {
  if (val instanceof RegExp) return true;
  return typeof val.flags === 'string'
    && typeof val.ignoreCase === 'boolean'
    && typeof val.multiline === 'boolean'
    && typeof val.global === 'boolean';
}

function isGeneratorFn(name, val) {
  return ctorName(name) === 'GeneratorFunction';
}

function isGeneratorObj(val) {
  return typeof val.throw === 'function'
    && typeof val.return === 'function'
    && typeof val.next === 'function';
}

function isArguments(val) {
  try {
    if (typeof val.length === 'number' && typeof val.callee === 'function') {
      return true;
    }
  } catch (err) {
    if (err.message.indexOf('callee') !== -1) {
      return true;
    }
  }
  return false;
}

/**
 * If you need to support Safari 5-7 (8-10 yr-old browser),
 * take a look at https://github.com/feross/is-buffer
 */

function isBuffer(val) {
  if (val.constructor && typeof val.constructor.isBuffer === 'function') {
    return val.constructor.isBuffer(val);
  }
  return false;
}


/***/ }),

/***/ 3973:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

module.exports = minimatch
minimatch.Minimatch = Minimatch

var path = { sep: '/' }
try {
  path = __nccwpck_require__(1017)
} catch (er) {}

var GLOBSTAR = minimatch.GLOBSTAR = Minimatch.GLOBSTAR = {}
var expand = __nccwpck_require__(3717)

var plTypes = {
  '!': { open: '(?:(?!(?:', close: '))[^/]*?)'},
  '?': { open: '(?:', close: ')?' },
  '+': { open: '(?:', close: ')+' },
  '*': { open: '(?:', close: ')*' },
  '@': { open: '(?:', close: ')' }
}

// any single thing other than /
// don't need to escape / when using new RegExp()
var qmark = '[^/]'

// * => any number of characters
var star = qmark + '*?'

// ** when dots are allowed.  Anything goes, except .. and .
// not (^ or / followed by one or two dots followed by $ or /),
// followed by anything, any number of times.
var twoStarDot = '(?:(?!(?:\\\/|^)(?:\\.{1,2})($|\\\/)).)*?'

// not a ^ or / followed by a dot,
// followed by anything, any number of times.
var twoStarNoDot = '(?:(?!(?:\\\/|^)\\.).)*?'

// characters that need to be escaped in RegExp.
var reSpecials = charSet('().*{}+?[]^$\\!')

// "abc" -> { a:true, b:true, c:true }
function charSet (s) {
  return s.split('').reduce(function (set, c) {
    set[c] = true
    return set
  }, {})
}

// normalizes slashes.
var slashSplit = /\/+/

minimatch.filter = filter
function filter (pattern, options) {
  options = options || {}
  return function (p, i, list) {
    return minimatch(p, pattern, options)
  }
}

function ext (a, b) {
  a = a || {}
  b = b || {}
  var t = {}
  Object.keys(b).forEach(function (k) {
    t[k] = b[k]
  })
  Object.keys(a).forEach(function (k) {
    t[k] = a[k]
  })
  return t
}

minimatch.defaults = function (def) {
  if (!def || !Object.keys(def).length) return minimatch

  var orig = minimatch

  var m = function minimatch (p, pattern, options) {
    return orig.minimatch(p, pattern, ext(def, options))
  }

  m.Minimatch = function Minimatch (pattern, options) {
    return new orig.Minimatch(pattern, ext(def, options))
  }

  return m
}

Minimatch.defaults = function (def) {
  if (!def || !Object.keys(def).length) return Minimatch
  return minimatch.defaults(def).Minimatch
}

function minimatch (p, pattern, options) {
  if (typeof pattern !== 'string') {
    throw new TypeError('glob pattern string required')
  }

  if (!options) options = {}

  // shortcut: comments match nothing.
  if (!options.nocomment && pattern.charAt(0) === '#') {
    return false
  }

  // "" only matches ""
  if (pattern.trim() === '') return p === ''

  return new Minimatch(pattern, options).match(p)
}

function Minimatch (pattern, options) {
  if (!(this instanceof Minimatch)) {
    return new Minimatch(pattern, options)
  }

  if (typeof pattern !== 'string') {
    throw new TypeError('glob pattern string required')
  }

  if (!options) options = {}
  pattern = pattern.trim()

  // windows support: need to use /, not \
  if (path.sep !== '/') {
    pattern = pattern.split(path.sep).join('/')
  }

  this.options = options
  this.set = []
  this.pattern = pattern
  this.regexp = null
  this.negate = false
  this.comment = false
  this.empty = false

  // make the set of regexps etc.
  this.make()
}

Minimatch.prototype.debug = function () {}

Minimatch.prototype.make = make
function make () {
  // don't do it more than once.
  if (this._made) return

  var pattern = this.pattern
  var options = this.options

  // empty patterns and comments match nothing.
  if (!options.nocomment && pattern.charAt(0) === '#') {
    this.comment = true
    return
  }
  if (!pattern) {
    this.empty = true
    return
  }

  // step 1: figure out negation, etc.
  this.parseNegate()

  // step 2: expand braces
  var set = this.globSet = this.braceExpand()

  if (options.debug) this.debug = console.error

  this.debug(this.pattern, set)

  // step 3: now we have a set, so turn each one into a series of path-portion
  // matching patterns.
  // These will be regexps, except in the case of "**", which is
  // set to the GLOBSTAR object for globstar behavior,
  // and will not contain any / characters
  set = this.globParts = set.map(function (s) {
    return s.split(slashSplit)
  })

  this.debug(this.pattern, set)

  // glob --> regexps
  set = set.map(function (s, si, set) {
    return s.map(this.parse, this)
  }, this)

  this.debug(this.pattern, set)

  // filter out everything that didn't compile properly.
  set = set.filter(function (s) {
    return s.indexOf(false) === -1
  })

  this.debug(this.pattern, set)

  this.set = set
}

Minimatch.prototype.parseNegate = parseNegate
function parseNegate () {
  var pattern = this.pattern
  var negate = false
  var options = this.options
  var negateOffset = 0

  if (options.nonegate) return

  for (var i = 0, l = pattern.length
    ; i < l && pattern.charAt(i) === '!'
    ; i++) {
    negate = !negate
    negateOffset++
  }

  if (negateOffset) this.pattern = pattern.substr(negateOffset)
  this.negate = negate
}

// Brace expansion:
// a{b,c}d -> abd acd
// a{b,}c -> abc ac
// a{0..3}d -> a0d a1d a2d a3d
// a{b,c{d,e}f}g -> abg acdfg acefg
// a{b,c}d{e,f}g -> abdeg acdeg abdeg abdfg
//
// Invalid sets are not expanded.
// a{2..}b -> a{2..}b
// a{b}c -> a{b}c
minimatch.braceExpand = function (pattern, options) {
  return braceExpand(pattern, options)
}

Minimatch.prototype.braceExpand = braceExpand

function braceExpand (pattern, options) {
  if (!options) {
    if (this instanceof Minimatch) {
      options = this.options
    } else {
      options = {}
    }
  }

  pattern = typeof pattern === 'undefined'
    ? this.pattern : pattern

  if (typeof pattern === 'undefined') {
    throw new TypeError('undefined pattern')
  }

  if (options.nobrace ||
    !pattern.match(/\{.*\}/)) {
    // shortcut. no need to expand.
    return [pattern]
  }

  return expand(pattern)
}

// parse a component of the expanded set.
// At this point, no pattern may contain "/" in it
// so we're going to return a 2d array, where each entry is the full
// pattern, split on '/', and then turned into a regular expression.
// A regexp is made at the end which joins each array with an
// escaped /, and another full one which joins each regexp with |.
//
// Following the lead of Bash 4.1, note that "**" only has special meaning
// when it is the *only* thing in a path portion.  Otherwise, any series
// of * is equivalent to a single *.  Globstar behavior is enabled by
// default, and can be disabled by setting options.noglobstar.
Minimatch.prototype.parse = parse
var SUBPARSE = {}
function parse (pattern, isSub) {
  if (pattern.length > 1024 * 64) {
    throw new TypeError('pattern is too long')
  }

  var options = this.options

  // shortcuts
  if (!options.noglobstar && pattern === '**') return GLOBSTAR
  if (pattern === '') return ''

  var re = ''
  var hasMagic = !!options.nocase
  var escaping = false
  // ? => one single character
  var patternListStack = []
  var negativeLists = []
  var stateChar
  var inClass = false
  var reClassStart = -1
  var classStart = -1
  // . and .. never match anything that doesn't start with .,
  // even when options.dot is set.
  var patternStart = pattern.charAt(0) === '.' ? '' // anything
  // not (start or / followed by . or .. followed by / or end)
  : options.dot ? '(?!(?:^|\\\/)\\.{1,2}(?:$|\\\/))'
  : '(?!\\.)'
  var self = this

  function clearStateChar () {
    if (stateChar) {
      // we had some state-tracking character
      // that wasn't consumed by this pass.
      switch (stateChar) {
        case '*':
          re += star
          hasMagic = true
        break
        case '?':
          re += qmark
          hasMagic = true
        break
        default:
          re += '\\' + stateChar
        break
      }
      self.debug('clearStateChar %j %j', stateChar, re)
      stateChar = false
    }
  }

  for (var i = 0, len = pattern.length, c
    ; (i < len) && (c = pattern.charAt(i))
    ; i++) {
    this.debug('%s\t%s %s %j', pattern, i, re, c)

    // skip over any that are escaped.
    if (escaping && reSpecials[c]) {
      re += '\\' + c
      escaping = false
      continue
    }

    switch (c) {
      case '/':
        // completely not allowed, even escaped.
        // Should already be path-split by now.
        return false

      case '\\':
        clearStateChar()
        escaping = true
      continue

      // the various stateChar values
      // for the "extglob" stuff.
      case '?':
      case '*':
      case '+':
      case '@':
      case '!':
        this.debug('%s\t%s %s %j <-- stateChar', pattern, i, re, c)

        // all of those are literals inside a class, except that
        // the glob [!a] means [^a] in regexp
        if (inClass) {
          this.debug('  in class')
          if (c === '!' && i === classStart + 1) c = '^'
          re += c
          continue
        }

        // if we already have a stateChar, then it means
        // that there was something like ** or +? in there.
        // Handle the stateChar, then proceed with this one.
        self.debug('call clearStateChar %j', stateChar)
        clearStateChar()
        stateChar = c
        // if extglob is disabled, then +(asdf|foo) isn't a thing.
        // just clear the statechar *now*, rather than even diving into
        // the patternList stuff.
        if (options.noext) clearStateChar()
      continue

      case '(':
        if (inClass) {
          re += '('
          continue
        }

        if (!stateChar) {
          re += '\\('
          continue
        }

        patternListStack.push({
          type: stateChar,
          start: i - 1,
          reStart: re.length,
          open: plTypes[stateChar].open,
          close: plTypes[stateChar].close
        })
        // negation is (?:(?!js)[^/]*)
        re += stateChar === '!' ? '(?:(?!(?:' : '(?:'
        this.debug('plType %j %j', stateChar, re)
        stateChar = false
      continue

      case ')':
        if (inClass || !patternListStack.length) {
          re += '\\)'
          continue
        }

        clearStateChar()
        hasMagic = true
        var pl = patternListStack.pop()
        // negation is (?:(?!js)[^/]*)
        // The others are (?:<pattern>)<type>
        re += pl.close
        if (pl.type === '!') {
          negativeLists.push(pl)
        }
        pl.reEnd = re.length
      continue

      case '|':
        if (inClass || !patternListStack.length || escaping) {
          re += '\\|'
          escaping = false
          continue
        }

        clearStateChar()
        re += '|'
      continue

      // these are mostly the same in regexp and glob
      case '[':
        // swallow any state-tracking char before the [
        clearStateChar()

        if (inClass) {
          re += '\\' + c
          continue
        }

        inClass = true
        classStart = i
        reClassStart = re.length
        re += c
      continue

      case ']':
        //  a right bracket shall lose its special
        //  meaning and represent itself in
        //  a bracket expression if it occurs
        //  first in the list.  -- POSIX.2 2.8.3.2
        if (i === classStart + 1 || !inClass) {
          re += '\\' + c
          escaping = false
          continue
        }

        // handle the case where we left a class open.
        // "[z-a]" is valid, equivalent to "\[z-a\]"
        if (inClass) {
          // split where the last [ was, make sure we don't have
          // an invalid re. if so, re-walk the contents of the
          // would-be class to re-translate any characters that
          // were passed through as-is
          // TODO: It would probably be faster to determine this
          // without a try/catch and a new RegExp, but it's tricky
          // to do safely.  For now, this is safe and works.
          var cs = pattern.substring(classStart + 1, i)
          try {
            RegExp('[' + cs + ']')
          } catch (er) {
            // not a valid class!
            var sp = this.parse(cs, SUBPARSE)
            re = re.substr(0, reClassStart) + '\\[' + sp[0] + '\\]'
            hasMagic = hasMagic || sp[1]
            inClass = false
            continue
          }
        }

        // finish up the class.
        hasMagic = true
        inClass = false
        re += c
      continue

      default:
        // swallow any state char that wasn't consumed
        clearStateChar()

        if (escaping) {
          // no need
          escaping = false
        } else if (reSpecials[c]
          && !(c === '^' && inClass)) {
          re += '\\'
        }

        re += c

    } // switch
  } // for

  // handle the case where we left a class open.
  // "[abc" is valid, equivalent to "\[abc"
  if (inClass) {
    // split where the last [ was, and escape it
    // this is a huge pita.  We now have to re-walk
    // the contents of the would-be class to re-translate
    // any characters that were passed through as-is
    cs = pattern.substr(classStart + 1)
    sp = this.parse(cs, SUBPARSE)
    re = re.substr(0, reClassStart) + '\\[' + sp[0]
    hasMagic = hasMagic || sp[1]
  }

  // handle the case where we had a +( thing at the *end*
  // of the pattern.
  // each pattern list stack adds 3 chars, and we need to go through
  // and escape any | chars that were passed through as-is for the regexp.
  // Go through and escape them, taking care not to double-escape any
  // | chars that were already escaped.
  for (pl = patternListStack.pop(); pl; pl = patternListStack.pop()) {
    var tail = re.slice(pl.reStart + pl.open.length)
    this.debug('setting tail', re, pl)
    // maybe some even number of \, then maybe 1 \, followed by a |
    tail = tail.replace(/((?:\\{2}){0,64})(\\?)\|/g, function (_, $1, $2) {
      if (!$2) {
        // the | isn't already escaped, so escape it.
        $2 = '\\'
      }

      // need to escape all those slashes *again*, without escaping the
      // one that we need for escaping the | character.  As it works out,
      // escaping an even number of slashes can be done by simply repeating
      // it exactly after itself.  That's why this trick works.
      //
      // I am sorry that you have to see this.
      return $1 + $1 + $2 + '|'
    })

    this.debug('tail=%j\n   %s', tail, tail, pl, re)
    var t = pl.type === '*' ? star
      : pl.type === '?' ? qmark
      : '\\' + pl.type

    hasMagic = true
    re = re.slice(0, pl.reStart) + t + '\\(' + tail
  }

  // handle trailing things that only matter at the very end.
  clearStateChar()
  if (escaping) {
    // trailing \\
    re += '\\\\'
  }

  // only need to apply the nodot start if the re starts with
  // something that could conceivably capture a dot
  var addPatternStart = false
  switch (re.charAt(0)) {
    case '.':
    case '[':
    case '(': addPatternStart = true
  }

  // Hack to work around lack of negative lookbehind in JS
  // A pattern like: *.!(x).!(y|z) needs to ensure that a name
  // like 'a.xyz.yz' doesn't match.  So, the first negative
  // lookahead, has to look ALL the way ahead, to the end of
  // the pattern.
  for (var n = negativeLists.length - 1; n > -1; n--) {
    var nl = negativeLists[n]

    var nlBefore = re.slice(0, nl.reStart)
    var nlFirst = re.slice(nl.reStart, nl.reEnd - 8)
    var nlLast = re.slice(nl.reEnd - 8, nl.reEnd)
    var nlAfter = re.slice(nl.reEnd)

    nlLast += nlAfter

    // Handle nested stuff like *(*.js|!(*.json)), where open parens
    // mean that we should *not* include the ) in the bit that is considered
    // "after" the negated section.
    var openParensBefore = nlBefore.split('(').length - 1
    var cleanAfter = nlAfter
    for (i = 0; i < openParensBefore; i++) {
      cleanAfter = cleanAfter.replace(/\)[+*?]?/, '')
    }
    nlAfter = cleanAfter

    var dollar = ''
    if (nlAfter === '' && isSub !== SUBPARSE) {
      dollar = '$'
    }
    var newRe = nlBefore + nlFirst + nlAfter + dollar + nlLast
    re = newRe
  }

  // if the re is not "" at this point, then we need to make sure
  // it doesn't match against an empty path part.
  // Otherwise a/* will match a/, which it should not.
  if (re !== '' && hasMagic) {
    re = '(?=.)' + re
  }

  if (addPatternStart) {
    re = patternStart + re
  }

  // parsing just a piece of a larger pattern.
  if (isSub === SUBPARSE) {
    return [re, hasMagic]
  }

  // skip the regexp for non-magical patterns
  // unescape anything in it, though, so that it'll be
  // an exact match against a file etc.
  if (!hasMagic) {
    return globUnescape(pattern)
  }

  var flags = options.nocase ? 'i' : ''
  try {
    var regExp = new RegExp('^' + re + '$', flags)
  } catch (er) {
    // If it was an invalid regular expression, then it can't match
    // anything.  This trick looks for a character after the end of
    // the string, which is of course impossible, except in multi-line
    // mode, but it's not a /m regex.
    return new RegExp('$.')
  }

  regExp._glob = pattern
  regExp._src = re

  return regExp
}

minimatch.makeRe = function (pattern, options) {
  return new Minimatch(pattern, options || {}).makeRe()
}

Minimatch.prototype.makeRe = makeRe
function makeRe () {
  if (this.regexp || this.regexp === false) return this.regexp

  // at this point, this.set is a 2d array of partial
  // pattern strings, or "**".
  //
  // It's better to use .match().  This function shouldn't
  // be used, really, but it's pretty convenient sometimes,
  // when you just want to work with a regex.
  var set = this.set

  if (!set.length) {
    this.regexp = false
    return this.regexp
  }
  var options = this.options

  var twoStar = options.noglobstar ? star
    : options.dot ? twoStarDot
    : twoStarNoDot
  var flags = options.nocase ? 'i' : ''

  var re = set.map(function (pattern) {
    return pattern.map(function (p) {
      return (p === GLOBSTAR) ? twoStar
      : (typeof p === 'string') ? regExpEscape(p)
      : p._src
    }).join('\\\/')
  }).join('|')

  // must match entire pattern
  // ending in a * or ** will make it less strict.
  re = '^(?:' + re + ')$'

  // can match anything, as long as it's not this.
  if (this.negate) re = '^(?!' + re + ').*$'

  try {
    this.regexp = new RegExp(re, flags)
  } catch (ex) {
    this.regexp = false
  }
  return this.regexp
}

minimatch.match = function (list, pattern, options) {
  options = options || {}
  var mm = new Minimatch(pattern, options)
  list = list.filter(function (f) {
    return mm.match(f)
  })
  if (mm.options.nonull && !list.length) {
    list.push(pattern)
  }
  return list
}

Minimatch.prototype.match = match
function match (f, partial) {
  this.debug('match', f, this.pattern)
  // short-circuit in the case of busted things.
  // comments, etc.
  if (this.comment) return false
  if (this.empty) return f === ''

  if (f === '/' && partial) return true

  var options = this.options

  // windows: need to use /, not \
  if (path.sep !== '/') {
    f = f.split(path.sep).join('/')
  }

  // treat the test path as a set of pathparts.
  f = f.split(slashSplit)
  this.debug(this.pattern, 'split', f)

  // just ONE of the pattern sets in this.set needs to match
  // in order for it to be valid.  If negating, then just one
  // match means that we have failed.
  // Either way, return on the first hit.

  var set = this.set
  this.debug(this.pattern, 'set', set)

  // Find the basename of the path by looking for the last non-empty segment
  var filename
  var i
  for (i = f.length - 1; i >= 0; i--) {
    filename = f[i]
    if (filename) break
  }

  for (i = 0; i < set.length; i++) {
    var pattern = set[i]
    var file = f
    if (options.matchBase && pattern.length === 1) {
      file = [filename]
    }
    var hit = this.matchOne(file, pattern, partial)
    if (hit) {
      if (options.flipNegate) return true
      return !this.negate
    }
  }

  // didn't get any hits.  this is success if it's a negative
  // pattern, failure otherwise.
  if (options.flipNegate) return false
  return this.negate
}

// set partial to true to test if, for example,
// "/a/b" matches the start of "/*/b/*/d"
// Partial means, if you run out of file before you run
// out of pattern, then that's fine, as long as all
// the parts match.
Minimatch.prototype.matchOne = function (file, pattern, partial) {
  var options = this.options

  this.debug('matchOne',
    { 'this': this, file: file, pattern: pattern })

  this.debug('matchOne', file.length, pattern.length)

  for (var fi = 0,
      pi = 0,
      fl = file.length,
      pl = pattern.length
      ; (fi < fl) && (pi < pl)
      ; fi++, pi++) {
    this.debug('matchOne loop')
    var p = pattern[pi]
    var f = file[fi]

    this.debug(pattern, p, f)

    // should be impossible.
    // some invalid regexp stuff in the set.
    if (p === false) return false

    if (p === GLOBSTAR) {
      this.debug('GLOBSTAR', [pattern, p, f])

      // "**"
      // a/**/b/**/c would match the following:
      // a/b/x/y/z/c
      // a/x/y/z/b/c
      // a/b/x/b/x/c
      // a/b/c
      // To do this, take the rest of the pattern after
      // the **, and see if it would match the file remainder.
      // If so, return success.
      // If not, the ** "swallows" a segment, and try again.
      // This is recursively awful.
      //
      // a/**/b/**/c matching a/b/x/y/z/c
      // - a matches a
      // - doublestar
      //   - matchOne(b/x/y/z/c, b/**/c)
      //     - b matches b
      //     - doublestar
      //       - matchOne(x/y/z/c, c) -> no
      //       - matchOne(y/z/c, c) -> no
      //       - matchOne(z/c, c) -> no
      //       - matchOne(c, c) yes, hit
      var fr = fi
      var pr = pi + 1
      if (pr === pl) {
        this.debug('** at the end')
        // a ** at the end will just swallow the rest.
        // We have found a match.
        // however, it will not swallow /.x, unless
        // options.dot is set.
        // . and .. are *never* matched by **, for explosively
        // exponential reasons.
        for (; fi < fl; fi++) {
          if (file[fi] === '.' || file[fi] === '..' ||
            (!options.dot && file[fi].charAt(0) === '.')) return false
        }
        return true
      }

      // ok, let's see if we can swallow whatever we can.
      while (fr < fl) {
        var swallowee = file[fr]

        this.debug('\nglobstar while', file, fr, pattern, pr, swallowee)

        // XXX remove this slice.  Just pass the start index.
        if (this.matchOne(file.slice(fr), pattern.slice(pr), partial)) {
          this.debug('globstar found match!', fr, fl, swallowee)
          // found a match.
          return true
        } else {
          // can't swallow "." or ".." ever.
          // can only swallow ".foo" when explicitly asked.
          if (swallowee === '.' || swallowee === '..' ||
            (!options.dot && swallowee.charAt(0) === '.')) {
            this.debug('dot detected!', file, fr, pattern, pr)
            break
          }

          // ** swallows a segment, and continue.
          this.debug('globstar swallow a segment, and continue')
          fr++
        }
      }

      // no match was found.
      // However, in partial mode, we can't say this is necessarily over.
      // If there's more *pattern* left, then
      if (partial) {
        // ran out of file
        this.debug('\n>>> no match, partial?', file, fr, pattern, pr)
        if (fr === fl) return true
      }
      return false
    }

    // something other than **
    // non-magic patterns just have to match exactly
    // patterns with magic have been turned into regexps.
    var hit
    if (typeof p === 'string') {
      if (options.nocase) {
        hit = f.toLowerCase() === p.toLowerCase()
      } else {
        hit = f === p
      }
      this.debug('string match', p, f, hit)
    } else {
      hit = f.match(p)
      this.debug('pattern match', p, f, hit)
    }

    if (!hit) return false
  }

  // Note: ending in / means that we'll get a final ""
  // at the end of the pattern.  This can only match a
  // corresponding "" at the end of the file.
  // If the file ends in /, then it can only match a
  // a pattern that ends in /, unless the pattern just
  // doesn't have any more for it. But, a/b/ should *not*
  // match "a/b/*", even though "" matches against the
  // [^/]*? pattern, except in partial mode, where it might
  // simply not be reached yet.
  // However, a/b/ should still satisfy a/*

  // now either we fell off the end of the pattern, or we're done.
  if (fi === fl && pi === pl) {
    // ran out of pattern and filename at the same time.
    // an exact hit!
    return true
  } else if (fi === fl) {
    // ran out of file, but still had pattern left.
    // this is ok if we're doing the match as part of
    // a glob fs traversal.
    return partial
  } else if (pi === pl) {
    // ran out of pattern, still have file left.
    // this is only acceptable if we're on the very last
    // empty segment of a file with a trailing slash.
    // a/* should match a/b/
    var emptyFileEnd = (fi === fl - 1) && (file[fi] === '')
    return emptyFileEnd
  }

  // should be unreachable.
  throw new Error('wtf?')
}

// replace stuff like \* with *
function globUnescape (s) {
  return s.replace(/\\(.)/g, '$1')
}

function regExpEscape (s) {
  return s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')
}


/***/ }),

/***/ 4540:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var isExtendable = __nccwpck_require__(9395);
var forIn = __nccwpck_require__(7198);

function mixinDeep(target, objects) {
  var len = arguments.length, i = 0;
  while (++i < len) {
    var obj = arguments[i];
    if (isObject(obj)) {
      forIn(obj, copy, target);
    }
  }
  return target;
}

/**
 * Copy properties from the source object to the
 * target object.
 *
 * @param  {*} `val`
 * @param  {String} `key`
 */

function copy(val, key) {
  if (!isValidKey(key)) {
    return;
  }

  var obj = this[key];
  if (isObject(val) && isObject(obj)) {
    mixinDeep(obj, val);
  } else {
    this[key] = val;
  }
}

/**
 * Returns true if `val` is an object or function.
 *
 * @param  {any} val
 * @return {Boolean}
 */

function isObject(val) {
  return isExtendable(val) && !Array.isArray(val);
}

/**
 * Returns true if `key` is a valid key to use when extending objects.
 *
 * @param  {String} `key`
 * @return {Boolean}
 */

function isValidKey(key) {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
};

/**
 * Expose `mixinDeep`
 */

module.exports = mixinDeep;


/***/ }),

/***/ 9395:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * is-extendable <https://github.com/jonschlinkert/is-extendable>
 *
 * Copyright (c) 2015-2017, Jon Schlinkert.
 * Released under the MIT License.
 */



var isPlainObject = __nccwpck_require__(7810);

module.exports = function isExtendable(val) {
  return isPlainObject(val) || typeof val === 'function' || Array.isArray(val);
};


/***/ }),

/***/ 900:
/***/ ((module) => {

/**
 * Helpers.
 */

var s = 1000;
var m = s * 60;
var h = m * 60;
var d = h * 24;
var y = d * 365.25;

/**
 * Parse or format the given `val`.
 *
 * Options:
 *
 *  - `long` verbose formatting [false]
 *
 * @param {String|Number} val
 * @param {Object} [options]
 * @throws {Error} throw an error if val is not a non-empty string or a number
 * @return {String|Number}
 * @api public
 */

module.exports = function(val, options) {
  options = options || {};
  var type = typeof val;
  if (type === 'string' && val.length > 0) {
    return parse(val);
  } else if (type === 'number' && isNaN(val) === false) {
    return options.long ? fmtLong(val) : fmtShort(val);
  }
  throw new Error(
    'val is not a non-empty string or a valid number. val=' +
      JSON.stringify(val)
  );
};

/**
 * Parse the given `str` and return milliseconds.
 *
 * @param {String} str
 * @return {Number}
 * @api private
 */

function parse(str) {
  str = String(str);
  if (str.length > 100) {
    return;
  }
  var match = /^((?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(
    str
  );
  if (!match) {
    return;
  }
  var n = parseFloat(match[1]);
  var type = (match[2] || 'ms').toLowerCase();
  switch (type) {
    case 'years':
    case 'year':
    case 'yrs':
    case 'yr':
    case 'y':
      return n * y;
    case 'days':
    case 'day':
    case 'd':
      return n * d;
    case 'hours':
    case 'hour':
    case 'hrs':
    case 'hr':
    case 'h':
      return n * h;
    case 'minutes':
    case 'minute':
    case 'mins':
    case 'min':
    case 'm':
      return n * m;
    case 'seconds':
    case 'second':
    case 'secs':
    case 'sec':
    case 's':
      return n * s;
    case 'milliseconds':
    case 'millisecond':
    case 'msecs':
    case 'msec':
    case 'ms':
      return n;
    default:
      return undefined;
  }
}

/**
 * Short format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function fmtShort(ms) {
  if (ms >= d) {
    return Math.round(ms / d) + 'd';
  }
  if (ms >= h) {
    return Math.round(ms / h) + 'h';
  }
  if (ms >= m) {
    return Math.round(ms / m) + 'm';
  }
  if (ms >= s) {
    return Math.round(ms / s) + 's';
  }
  return ms + 'ms';
}

/**
 * Long format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function fmtLong(ms) {
  return plural(ms, d, 'day') ||
    plural(ms, h, 'hour') ||
    plural(ms, m, 'minute') ||
    plural(ms, s, 'second') ||
    ms + ' ms';
}

/**
 * Pluralization helper.
 */

function plural(ms, n, name) {
  if (ms < n) {
    return;
  }
  if (ms < n * 1.5) {
    return Math.floor(ms / n) + ' ' + name;
  }
  return Math.ceil(ms / n) + ' ' + name + 's';
}


/***/ }),

/***/ 2316:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



/**
 * Module dependencies
 */

var util = __nccwpck_require__(3837);
var toRegex = __nccwpck_require__(6855);
var extend = __nccwpck_require__(6254);

/**
 * Local dependencies
 */

var compilers = __nccwpck_require__(4482);
var parsers = __nccwpck_require__(8826);
var cache = __nccwpck_require__(8672);
var utils = __nccwpck_require__(5156);
var MAX_LENGTH = 1024 * 64;

/**
 * The main function takes a list of strings and one or more
 * glob patterns to use for matching.
 *
 * ```js
 * var nm = require('nanomatch');
 * nm(list, patterns[, options]);
 *
 * console.log(nm(['a.js', 'a.txt'], ['*.js']));
 * //=> [ 'a.js' ]
 * ```
 * @param {Array} `list` A list of strings to match
 * @param {String|Array} `patterns` One or more glob patterns to use for matching.
 * @param {Object} `options` See available [options](#options) for changing how matches are performed
 * @return {Array} Returns an array of matches
 * @summary false
 * @api public
 */

function nanomatch(list, patterns, options) {
  patterns = utils.arrayify(patterns);
  list = utils.arrayify(list);

  var len = patterns.length;
  if (list.length === 0 || len === 0) {
    return [];
  }

  if (len === 1) {
    return nanomatch.match(list, patterns[0], options);
  }

  var negated = false;
  var omit = [];
  var keep = [];
  var idx = -1;

  while (++idx < len) {
    var pattern = patterns[idx];

    if (typeof pattern === 'string' && pattern.charCodeAt(0) === 33 /* ! */) {
      omit.push.apply(omit, nanomatch.match(list, pattern.slice(1), options));
      negated = true;
    } else {
      keep.push.apply(keep, nanomatch.match(list, pattern, options));
    }
  }

  // minimatch.match parity
  if (negated && keep.length === 0) {
    if (options && options.unixify === false) {
      keep = list.slice();
    } else {
      var unixify = utils.unixify(options);
      for (var i = 0; i < list.length; i++) {
        keep.push(unixify(list[i]));
      }
    }
  }

  var matches = utils.diff(keep, omit);
  if (!options || options.nodupes !== false) {
    return utils.unique(matches);
  }

  return matches;
}

/**
 * Similar to the main function, but `pattern` must be a string.
 *
 * ```js
 * var nm = require('nanomatch');
 * nm.match(list, pattern[, options]);
 *
 * console.log(nm.match(['a.a', 'a.aa', 'a.b', 'a.c'], '*.a'));
 * //=> ['a.a', 'a.aa']
 * ```
 * @param {Array} `list` Array of strings to match
 * @param {String} `pattern` Glob pattern to use for matching.
 * @param {Object} `options` See available [options](#options) for changing how matches are performed
 * @return {Array} Returns an array of matches
 * @api public
 */

nanomatch.match = function(list, pattern, options) {
  if (Array.isArray(pattern)) {
    throw new TypeError('expected pattern to be a string');
  }

  var unixify = utils.unixify(options);
  var isMatch = memoize('match', pattern, options, nanomatch.matcher);
  var matches = [];

  list = utils.arrayify(list);
  var len = list.length;
  var idx = -1;

  while (++idx < len) {
    var ele = list[idx];
    if (ele === pattern || isMatch(ele)) {
      matches.push(utils.value(ele, unixify, options));
    }
  }

  // if no options were passed, uniquify results and return
  if (typeof options === 'undefined') {
    return utils.unique(matches);
  }

  if (matches.length === 0) {
    if (options.failglob === true) {
      throw new Error('no matches found for "' + pattern + '"');
    }
    if (options.nonull === true || options.nullglob === true) {
      return [options.unescape ? utils.unescape(pattern) : pattern];
    }
  }

  // if `opts.ignore` was defined, diff ignored list
  if (options.ignore) {
    matches = nanomatch.not(matches, options.ignore, options);
  }

  return options.nodupes !== false ? utils.unique(matches) : matches;
};

/**
 * Returns true if the specified `string` matches the given glob `pattern`.
 *
 * ```js
 * var nm = require('nanomatch');
 * nm.isMatch(string, pattern[, options]);
 *
 * console.log(nm.isMatch('a.a', '*.a'));
 * //=> true
 * console.log(nm.isMatch('a.b', '*.a'));
 * //=> false
 * ```
 * @param {String} `string` String to match
 * @param {String} `pattern` Glob pattern to use for matching.
 * @param {Object} `options` See available [options](#options) for changing how matches are performed
 * @return {Boolean} Returns true if the string matches the glob pattern.
 * @api public
 */

nanomatch.isMatch = function(str, pattern, options) {
  if (typeof str !== 'string') {
    throw new TypeError('expected a string: "' + util.inspect(str) + '"');
  }

  if (utils.isEmptyString(str) || utils.isEmptyString(pattern)) {
    return false;
  }

  var equals = utils.equalsPattern(options);
  if (equals(str)) {
    return true;
  }

  var isMatch = memoize('isMatch', pattern, options, nanomatch.matcher);
  return isMatch(str);
};

/**
 * Returns true if some of the elements in the given `list` match any of the
 * given glob `patterns`.
 *
 * ```js
 * var nm = require('nanomatch');
 * nm.some(list, patterns[, options]);
 *
 * console.log(nm.some(['foo.js', 'bar.js'], ['*.js', '!foo.js']));
 * // true
 * console.log(nm.some(['foo.js'], ['*.js', '!foo.js']));
 * // false
 * ```
 * @param  {String|Array} `list` The string or array of strings to test. Returns as soon as the first match is found.
 * @param {String|Array} `patterns` One or more glob patterns to use for matching.
 * @param {Object} `options` See available [options](#options) for changing how matches are performed
 * @return {Boolean} Returns true if any patterns match `str`
 * @api public
 */

nanomatch.some = function(list, patterns, options) {
  if (typeof list === 'string') {
    list = [list];
  }

  for (var i = 0; i < list.length; i++) {
    if (nanomatch(list[i], patterns, options).length === 1) {
      return true;
    }
  }

  return false;
};

/**
 * Returns true if every element in the given `list` matches
 * at least one of the given glob `patterns`.
 *
 * ```js
 * var nm = require('nanomatch');
 * nm.every(list, patterns[, options]);
 *
 * console.log(nm.every('foo.js', ['foo.js']));
 * // true
 * console.log(nm.every(['foo.js', 'bar.js'], ['*.js']));
 * // true
 * console.log(nm.every(['foo.js', 'bar.js'], ['*.js', '!foo.js']));
 * // false
 * console.log(nm.every(['foo.js'], ['*.js', '!foo.js']));
 * // false
 * ```
 * @param  {String|Array} `list` The string or array of strings to test.
 * @param {String|Array} `patterns` One or more glob patterns to use for matching.
 * @param {Object} `options` See available [options](#options) for changing how matches are performed
 * @return {Boolean} Returns true if any patterns match `str`
 * @api public
 */

nanomatch.every = function(list, patterns, options) {
  if (typeof list === 'string') {
    list = [list];
  }

  for (var i = 0; i < list.length; i++) {
    if (nanomatch(list[i], patterns, options).length !== 1) {
      return false;
    }
  }

  return true;
};

/**
 * Returns true if **any** of the given glob `patterns`
 * match the specified `string`.
 *
 * ```js
 * var nm = require('nanomatch');
 * nm.any(string, patterns[, options]);
 *
 * console.log(nm.any('a.a', ['b.*', '*.a']));
 * //=> true
 * console.log(nm.any('a.a', 'b.*'));
 * //=> false
 * ```
 * @param  {String|Array} `str` The string to test.
 * @param {String|Array} `patterns` One or more glob patterns to use for matching.
 * @param {Object} `options` See available [options](#options) for changing how matches are performed
 * @return {Boolean} Returns true if any patterns match `str`
 * @api public
 */

nanomatch.any = function(str, patterns, options) {
  if (typeof str !== 'string') {
    throw new TypeError('expected a string: "' + util.inspect(str) + '"');
  }

  if (utils.isEmptyString(str) || utils.isEmptyString(patterns)) {
    return false;
  }

  if (typeof patterns === 'string') {
    patterns = [patterns];
  }

  for (var i = 0; i < patterns.length; i++) {
    if (nanomatch.isMatch(str, patterns[i], options)) {
      return true;
    }
  }
  return false;
};

/**
 * Returns true if **all** of the given `patterns`
 * match the specified string.
 *
 * ```js
 * var nm = require('nanomatch');
 * nm.all(string, patterns[, options]);
 *
 * console.log(nm.all('foo.js', ['foo.js']));
 * // true
 *
 * console.log(nm.all('foo.js', ['*.js', '!foo.js']));
 * // false
 *
 * console.log(nm.all('foo.js', ['*.js', 'foo.js']));
 * // true
 *
 * console.log(nm.all('foo.js', ['*.js', 'f*', '*o*', '*o.js']));
 * // true
 * ```
 * @param  {String|Array} `str` The string to test.
 * @param {String|Array} `patterns` One or more glob patterns to use for matching.
 * @param {Object} `options` See available [options](#options) for changing how matches are performed
 * @return {Boolean} Returns true if any patterns match `str`
 * @api public
 */

nanomatch.all = function(str, patterns, options) {
  if (typeof str !== 'string') {
    throw new TypeError('expected a string: "' + util.inspect(str) + '"');
  }

  if (typeof patterns === 'string') {
    patterns = [patterns];
  }

  for (var i = 0; i < patterns.length; i++) {
    if (!nanomatch.isMatch(str, patterns[i], options)) {
      return false;
    }
  }
  return true;
};

/**
 * Returns a list of strings that _**do not match any**_ of the given `patterns`.
 *
 * ```js
 * var nm = require('nanomatch');
 * nm.not(list, patterns[, options]);
 *
 * console.log(nm.not(['a.a', 'b.b', 'c.c'], '*.a'));
 * //=> ['b.b', 'c.c']
 * ```
 * @param {Array} `list` Array of strings to match.
 * @param {String|Array} `patterns` One or more glob pattern to use for matching.
 * @param {Object} `options` See available [options](#options) for changing how matches are performed
 * @return {Array} Returns an array of strings that **do not match** the given patterns.
 * @api public
 */

nanomatch.not = function(list, patterns, options) {
  var opts = extend({}, options);
  var ignore = opts.ignore;
  delete opts.ignore;

  list = utils.arrayify(list);

  var matches = utils.diff(list, nanomatch(list, patterns, opts));
  if (ignore) {
    matches = utils.diff(matches, nanomatch(list, ignore));
  }

  return opts.nodupes !== false ? utils.unique(matches) : matches;
};

/**
 * Returns true if the given `string` contains the given pattern. Similar
 * to [.isMatch](#isMatch) but the pattern can match any part of the string.
 *
 * ```js
 * var nm = require('nanomatch');
 * nm.contains(string, pattern[, options]);
 *
 * console.log(nm.contains('aa/bb/cc', '*b'));
 * //=> true
 * console.log(nm.contains('aa/bb/cc', '*d'));
 * //=> false
 * ```
 * @param {String} `str` The string to match.
 * @param {String|Array} `patterns` Glob pattern to use for matching.
 * @param {Object} `options` See available [options](#options) for changing how matches are performed
 * @return {Boolean} Returns true if the patter matches any part of `str`.
 * @api public
 */

nanomatch.contains = function(str, patterns, options) {
  if (typeof str !== 'string') {
    throw new TypeError('expected a string: "' + util.inspect(str) + '"');
  }

  if (typeof patterns === 'string') {
    if (utils.isEmptyString(str) || utils.isEmptyString(patterns)) {
      return false;
    }

    var equals = utils.equalsPattern(patterns, options);
    if (equals(str)) {
      return true;
    }
    var contains = utils.containsPattern(patterns, options);
    if (contains(str)) {
      return true;
    }
  }

  var opts = extend({}, options, {contains: true});
  return nanomatch.any(str, patterns, opts);
};

/**
 * Returns true if the given pattern and options should enable
 * the `matchBase` option.
 * @return {Boolean}
 * @api private
 */

nanomatch.matchBase = function(pattern, options) {
  if (pattern && pattern.indexOf('/') !== -1 || !options) return false;
  return options.basename === true || options.matchBase === true;
};

/**
 * Filter the keys of the given object with the given `glob` pattern
 * and `options`. Does not attempt to match nested keys. If you need this feature,
 * use [glob-object][] instead.
 *
 * ```js
 * var nm = require('nanomatch');
 * nm.matchKeys(object, patterns[, options]);
 *
 * var obj = { aa: 'a', ab: 'b', ac: 'c' };
 * console.log(nm.matchKeys(obj, '*b'));
 * //=> { ab: 'b' }
 * ```
 * @param {Object} `object` The object with keys to filter.
 * @param {String|Array} `patterns` One or more glob patterns to use for matching.
 * @param {Object} `options` See available [options](#options) for changing how matches are performed
 * @return {Object} Returns an object with only keys that match the given patterns.
 * @api public
 */

nanomatch.matchKeys = function(obj, patterns, options) {
  if (!utils.isObject(obj)) {
    throw new TypeError('expected the first argument to be an object');
  }
  var keys = nanomatch(Object.keys(obj), patterns, options);
  return utils.pick(obj, keys);
};

/**
 * Returns a memoized matcher function from the given glob `pattern` and `options`.
 * The returned function takes a string to match as its only argument and returns
 * true if the string is a match.
 *
 * ```js
 * var nm = require('nanomatch');
 * nm.matcher(pattern[, options]);
 *
 * var isMatch = nm.matcher('*.!(*a)');
 * console.log(isMatch('a.a'));
 * //=> false
 * console.log(isMatch('a.b'));
 * //=> true
 * ```
 * @param {String} `pattern` Glob pattern
 * @param {Object} `options` See available [options](#options) for changing how matches are performed.
 * @return {Function} Returns a matcher function.
 * @api public
 */

nanomatch.matcher = function matcher(pattern, options) {
  if (utils.isEmptyString(pattern)) {
    return function() {
      return false;
    };
  }

  if (Array.isArray(pattern)) {
    return compose(pattern, options, matcher);
  }

  // if pattern is a regex
  if (pattern instanceof RegExp) {
    return test(pattern);
  }

  // if pattern is invalid
  if (!utils.isString(pattern)) {
    throw new TypeError('expected pattern to be an array, string or regex');
  }

  // if pattern is a non-glob string
  if (!utils.hasSpecialChars(pattern)) {
    if (options && options.nocase === true) {
      pattern = pattern.toLowerCase();
    }
    return utils.matchPath(pattern, options);
  }

  // if pattern is a glob string
  var re = nanomatch.makeRe(pattern, options);

  // if `options.matchBase` or `options.basename` is defined
  if (nanomatch.matchBase(pattern, options)) {
    return utils.matchBasename(re, options);
  }

  function test(regex) {
    var equals = utils.equalsPattern(options);
    var unixify = utils.unixify(options);

    return function(str) {
      if (equals(str)) {
        return true;
      }

      if (regex.test(unixify(str))) {
        return true;
      }
      return false;
    };
  }

  // create matcher function
  var matcherFn = test(re);
  // set result object from compiler on matcher function,
  // as a non-enumerable property. useful for debugging
  utils.define(matcherFn, 'result', re.result);
  return matcherFn;
};

/**
 * Returns an array of matches captured by `pattern` in `string, or
 * `null` if the pattern did not match.
 *
 * ```js
 * var nm = require('nanomatch');
 * nm.capture(pattern, string[, options]);
 *
 * console.log(nm.capture('test/*.js', 'test/foo.js'));
 * //=> ['foo']
 * console.log(nm.capture('test/*.js', 'foo/bar.css'));
 * //=> null
 * ```
 * @param {String} `pattern` Glob pattern to use for matching.
 * @param {String} `string` String to match
 * @param {Object} `options` See available [options](#options) for changing how matches are performed
 * @return {Boolean} Returns an array of captures if the string matches the glob pattern, otherwise `null`.
 * @api public
 */

nanomatch.capture = function(pattern, str, options) {
  var re = nanomatch.makeRe(pattern, extend({capture: true}, options));
  var unixify = utils.unixify(options);

  function match() {
    return function(string) {
      var match = re.exec(unixify(string));
      if (!match) {
        return null;
      }

      return match.slice(1);
    };
  }

  var capture = memoize('capture', pattern, options, match);
  return capture(str);
};

/**
 * Create a regular expression from the given glob `pattern`.
 *
 * ```js
 * var nm = require('nanomatch');
 * nm.makeRe(pattern[, options]);
 *
 * console.log(nm.makeRe('*.js'));
 * //=> /^(?:(\.[\\\/])?(?!\.)(?=.)[^\/]*?\.js)$/
 * ```
 * @param {String} `pattern` A glob pattern to convert to regex.
 * @param {Object} `options` See available [options](#options) for changing how matches are performed.
 * @return {RegExp} Returns a regex created from the given pattern.
 * @api public
 */

nanomatch.makeRe = function(pattern, options) {
  if (pattern instanceof RegExp) {
    return pattern;
  }

  if (typeof pattern !== 'string') {
    throw new TypeError('expected pattern to be a string');
  }

  if (pattern.length > MAX_LENGTH) {
    throw new Error('expected pattern to be less than ' + MAX_LENGTH + ' characters');
  }

  function makeRe() {
    var opts = utils.extend({wrap: false}, options);
    var result = nanomatch.create(pattern, opts);
    var regex = toRegex(result.output, opts);
    utils.define(regex, 'result', result);
    return regex;
  }

  return memoize('makeRe', pattern, options, makeRe);
};

/**
 * Parses the given glob `pattern` and returns an object with the compiled `output`
 * and optional source `map`.
 *
 * ```js
 * var nm = require('nanomatch');
 * nm.create(pattern[, options]);
 *
 * console.log(nm.create('abc/*.js'));
 * // { options: { source: 'string', sourcemap: true },
 * //   state: {},
 * //   compilers:
 * //    { ... },
 * //   output: '(\\.[\\\\\\/])?abc\\/(?!\\.)(?=.)[^\\/]*?\\.js',
 * //   ast:
 * //    { type: 'root',
 * //      errors: [],
 * //      nodes:
 * //       [ ... ],
 * //      dot: false,
 * //      input: 'abc/*.js' },
 * //   parsingErrors: [],
 * //   map:
 * //    { version: 3,
 * //      sources: [ 'string' ],
 * //      names: [],
 * //      mappings: 'AAAA,GAAG,EAAC,kBAAC,EAAC,EAAE',
 * //      sourcesContent: [ 'abc/*.js' ] },
 * //   position: { line: 1, column: 28 },
 * //   content: {},
 * //   files: {},
 * //   idx: 6 }
 * ```
 * @param {String} `pattern` Glob pattern to parse and compile.
 * @param {Object} `options` Any [options](#options) to change how parsing and compiling is performed.
 * @return {Object} Returns an object with the parsed AST, compiled string and optional source map.
 * @api public
 */

nanomatch.create = function(pattern, options) {
  if (typeof pattern !== 'string') {
    throw new TypeError('expected a string');
  }
  function create() {
    return nanomatch.compile(nanomatch.parse(pattern, options), options);
  }
  return memoize('create', pattern, options, create);
};

/**
 * Parse the given `str` with the given `options`.
 *
 * ```js
 * var nm = require('nanomatch');
 * nm.parse(pattern[, options]);
 *
 * var ast = nm.parse('a/{b,c}/d');
 * console.log(ast);
 * // { type: 'root',
 * //   errors: [],
 * //   input: 'a/{b,c}/d',
 * //   nodes:
 * //    [ { type: 'bos', val: '' },
 * //      { type: 'text', val: 'a/' },
 * //      { type: 'brace',
 * //        nodes:
 * //         [ { type: 'brace.open', val: '{' },
 * //           { type: 'text', val: 'b,c' },
 * //           { type: 'brace.close', val: '}' } ] },
 * //      { type: 'text', val: '/d' },
 * //      { type: 'eos', val: '' } ] }
 * ```
 * @param {String} `str`
 * @param {Object} `options`
 * @return {Object} Returns an AST
 * @api public
 */

nanomatch.parse = function(pattern, options) {
  if (typeof pattern !== 'string') {
    throw new TypeError('expected a string');
  }

  function parse() {
    var snapdragon = utils.instantiate(null, options);
    parsers(snapdragon, options);

    var ast = snapdragon.parse(pattern, options);
    utils.define(ast, 'snapdragon', snapdragon);
    ast.input = pattern;
    return ast;
  }

  return memoize('parse', pattern, options, parse);
};

/**
 * Compile the given `ast` or string with the given `options`.
 *
 * ```js
 * var nm = require('nanomatch');
 * nm.compile(ast[, options]);
 *
 * var ast = nm.parse('a/{b,c}/d');
 * console.log(nm.compile(ast));
 * // { options: { source: 'string' },
 * //   state: {},
 * //   compilers:
 * //    { eos: [Function],
 * //      noop: [Function],
 * //      bos: [Function],
 * //      brace: [Function],
 * //      'brace.open': [Function],
 * //      text: [Function],
 * //      'brace.close': [Function] },
 * //   output: [ 'a/(b|c)/d' ],
 * //   ast:
 * //    { ... },
 * //   parsingErrors: [] }
 * ```
 * @param {Object|String} `ast`
 * @param {Object} `options`
 * @return {Object} Returns an object that has an `output` property with the compiled string.
 * @api public
 */

nanomatch.compile = function(ast, options) {
  if (typeof ast === 'string') {
    ast = nanomatch.parse(ast, options);
  }

  function compile() {
    var snapdragon = utils.instantiate(ast, options);
    compilers(snapdragon, options);
    return snapdragon.compile(ast, options);
  }

  return memoize('compile', ast.input, options, compile);
};

/**
 * Clear the regex cache.
 *
 * ```js
 * nm.clearCache();
 * ```
 * @api public
 */

nanomatch.clearCache = function() {
  nanomatch.cache.__data__ = {};
};

/**
 * Compose a matcher function with the given patterns.
 * This allows matcher functions to be compiled once and
 * called multiple times.
 */

function compose(patterns, options, matcher) {
  var matchers;

  return memoize('compose', String(patterns), options, function() {
    return function(file) {
      // delay composition until it's invoked the first time,
      // after that it won't be called again
      if (!matchers) {
        matchers = [];
        for (var i = 0; i < patterns.length; i++) {
          matchers.push(matcher(patterns[i], options));
        }
      }

      var len = matchers.length;
      while (len--) {
        if (matchers[len](file) === true) {
          return true;
        }
      }
      return false;
    };
  });
}

/**
 * Memoize a generated regex or function. A unique key is generated
 * from the `type` (usually method name), the `pattern`, and
 * user-defined options.
 */

function memoize(type, pattern, options, fn) {
  var key = utils.createKey(type + '=' + pattern, options);

  if (options && options.cache === false) {
    return fn(pattern, options);
  }

  if (cache.has(type, key)) {
    return cache.get(type, key);
  }

  var val = fn(pattern, options);
  cache.set(type, key, val);
  return val;
}

/**
 * Expose compiler, parser and cache on `nanomatch`
 */

nanomatch.compilers = compilers;
nanomatch.parsers = parsers;
nanomatch.cache = cache;

/**
 * Expose `nanomatch`
 * @type {Function}
 */

module.exports = nanomatch;


/***/ }),

/***/ 8672:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

module.exports = new (__nccwpck_require__(4838))();


/***/ }),

/***/ 4482:
/***/ ((module) => {



/**
* Nanomatch compilers
*/

module.exports = function(nanomatch, options) {
  function slash() {
    if (options && typeof options.slash === 'string') {
      return options.slash;
    }
    if (options && typeof options.slash === 'function') {
      return options.slash.call(nanomatch);
    }
    return '\\\\/';
  }

  function star() {
    if (options && typeof options.star === 'string') {
      return options.star;
    }
    if (options && typeof options.star === 'function') {
      return options.star.call(nanomatch);
    }
    return '[^' + slash() + ']*?';
  }

  var ast = nanomatch.ast = nanomatch.parser.ast;
  ast.state = nanomatch.parser.state;
  nanomatch.compiler.state = ast.state;
  nanomatch.compiler

    /**
     * Negation / escaping
     */

    .set('not', function(node) {
      var prev = this.prev();
      if (this.options.nonegate === true || prev.type !== 'bos') {
        return this.emit('\\' + node.val, node);
      }
      return this.emit(node.val, node);
    })
    .set('escape', function(node) {
      if (this.options.unescape && /^[-\w_.]/.test(node.val)) {
        return this.emit(node.val, node);
      }
      return this.emit('\\' + node.val, node);
    })
    .set('quoted', function(node) {
      return this.emit(node.val, node);
    })

    /**
     * Regex
     */

    .set('dollar', function(node) {
      if (node.parent.type === 'bracket') {
        return this.emit(node.val, node);
      }
      return this.emit('\\' + node.val, node);
    })

    /**
     * Dot: "."
     */

    .set('dot', function(node) {
      if (node.dotfiles === true) this.dotfiles = true;
      return this.emit('\\' + node.val, node);
    })

    /**
     * Slashes: "/" and "\"
     */

    .set('backslash', function(node) {
      return this.emit(node.val, node);
    })
    .set('slash', function(node, nodes, i) {
      var val = '[' + slash() + ']';
      var parent = node.parent;
      var prev = this.prev();

      // set "node.hasSlash" to true on all ancestor parens nodes
      while (parent.type === 'paren' && !parent.hasSlash) {
        parent.hasSlash = true;
        parent = parent.parent;
      }

      if (prev.addQmark) {
        val += '?';
      }

      // word boundary
      if (node.rest.slice(0, 2) === '\\b') {
        return this.emit(val, node);
      }

      // globstars
      if (node.parsed === '**' || node.parsed === './**') {
        this.output = '(?:' + this.output;
        return this.emit(val + ')?', node);
      }

      // negation
      if (node.parsed === '!**' && this.options.nonegate !== true) {
        return this.emit(val + '?\\b', node);
      }
      return this.emit(val, node);
    })

    /**
     * Square brackets
     */

    .set('bracket', function(node) {
      var close = node.close;
      var open = !node.escaped ? '[' : '\\[';
      var negated = node.negated;
      var inner = node.inner;
      var val = node.val;

      if (node.escaped === true) {
        inner = inner.replace(/\\?(\W)/g, '\\$1');
        negated = '';
      }

      if (inner === ']-') {
        inner = '\\]\\-';
      }

      if (negated && inner.indexOf('.') === -1) {
        inner += '.';
      }
      if (negated && inner.indexOf('/') === -1) {
        inner += '/';
      }

      val = open + negated + inner + close;
      return this.emit(val, node);
    })

    /**
     * Square: "[.]" (only matches a single character in brackets)
     */

    .set('square', function(node) {
      var val = (/^\W/.test(node.val) ? '\\' : '') + node.val;
      return this.emit(val, node);
    })

    /**
     * Question mark: "?"
     */

    .set('qmark', function(node) {
      var prev = this.prev();
      // don't use "slash" variable so that we always avoid
      // matching backslashes and slashes with a qmark
      var val = '[^.\\\\/]';
      if (this.options.dot || (prev.type !== 'bos' && prev.type !== 'slash')) {
        val = '[^\\\\/]';
      }

      if (node.parsed.slice(-1) === '(') {
        var ch = node.rest.charAt(0);
        if (ch === '!' || ch === '=' || ch === ':') {
          return this.emit(node.val, node);
        }
      }

      if (node.val.length > 1) {
        val += '{' + node.val.length + '}';
      }
      return this.emit(val, node);
    })

    /**
     * Plus
     */

    .set('plus', function(node) {
      var prev = node.parsed.slice(-1);
      if (prev === ']' || prev === ')') {
        return this.emit(node.val, node);
      }
      if (!this.output || (/[?*+]/.test(ch) && node.parent.type !== 'bracket')) {
        return this.emit('\\+', node);
      }
      var ch = this.output.slice(-1);
      if (/\w/.test(ch) && !node.inside) {
        return this.emit('+\\+?', node);
      }
      return this.emit('+', node);
    })

    /**
     * globstar: '**'
     */

    .set('globstar', function(node, nodes, i) {
      if (!this.output) {
        this.state.leadingGlobstar = true;
      }

      var prev = this.prev();
      var before = this.prev(2);
      var next = this.next();
      var after = this.next(2);
      var type = prev.type;
      var val = node.val;

      if (prev.type === 'slash' && next.type === 'slash') {
        if (before.type === 'text') {
          this.output += '?';

          if (after.type !== 'text') {
            this.output += '\\b';
          }
        }
      }

      var parsed = node.parsed;
      if (parsed.charAt(0) === '!') {
        parsed = parsed.slice(1);
      }

      var isInside = node.isInside.paren || node.isInside.brace;
      if (parsed && type !== 'slash' && type !== 'bos' && !isInside) {
        val = star();
      } else {
        val = this.options.dot !== true
          ? '(?:(?!(?:[' + slash() + ']|^)\\.).)*?'
          : '(?:(?!(?:[' + slash() + ']|^)(?:\\.{1,2})($|[' + slash() + ']))(?!\\.{2}).)*?';
      }

      if ((type === 'slash' || type === 'bos') && this.options.dot !== true) {
        val = '(?!\\.)' + val;
      }

      if (prev.type === 'slash' && next.type === 'slash' && before.type !== 'text') {
        if (after.type === 'text' || after.type === 'star') {
          node.addQmark = true;
        }
      }

      if (this.options.capture) {
        val = '(' + val + ')';
      }

      return this.emit(val, node);
    })

    /**
     * Star: "*"
     */

    .set('star', function(node, nodes, i) {
      var prior = nodes[i - 2] || {};
      var prev = this.prev();
      var next = this.next();
      var type = prev.type;

      function isStart(n) {
        return n.type === 'bos' || n.type === 'slash';
      }

      if (this.output === '' && this.options.contains !== true) {
        this.output = '(?![' + slash() + '])';
      }

      if (type === 'bracket' && this.options.bash === false) {
        var str = next && next.type === 'bracket' ? star() : '*?';
        if (!prev.nodes || prev.nodes[1].type !== 'posix') {
          return this.emit(str, node);
        }
      }

      var prefix = !this.dotfiles && type !== 'text' && type !== 'escape'
        ? (this.options.dot ? '(?!(?:^|[' + slash() + '])\\.{1,2}(?:$|[' + slash() + ']))' : '(?!\\.)')
        : '';

      if (isStart(prev) || (isStart(prior) && type === 'not')) {
        if (prefix !== '(?!\\.)') {
          prefix += '(?!(\\.{2}|\\.[' + slash() + ']))(?=.)';
        } else {
          prefix += '(?=.)';
        }
      } else if (prefix === '(?!\\.)') {
        prefix = '';
      }

      if (prev.type === 'not' && prior.type === 'bos' && this.options.dot === true) {
        this.output = '(?!\\.)' + this.output;
      }

      var output = prefix + star();
      if (this.options.capture) {
        output = '(' + output + ')';
      }

      return this.emit(output, node);
    })

    /**
     * Text
     */

    .set('text', function(node) {
      return this.emit(node.val, node);
    })

    /**
     * End-of-string
     */

    .set('eos', function(node) {
      var prev = this.prev();
      var val = node.val;

      this.output = '(?:\\.[' + slash() + '](?=.))?' + this.output;
      if (this.state.metachar && prev.type !== 'qmark' && prev.type !== 'slash') {
        val += (this.options.contains ? '[' + slash() + ']?' : '(?:[' + slash() + ']|$)');
      }

      return this.emit(val, node);
    });

  /**
   * Allow custom compilers to be passed on options
   */

  if (options && typeof options.compilers === 'function') {
    options.compilers(nanomatch.compiler);
  }
};



/***/ }),

/***/ 8826:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var regexNot = __nccwpck_require__(2527);
var toRegex = __nccwpck_require__(6855);

/**
 * Characters to use in negation regex (we want to "not" match
 * characters that are matched by other parsers)
 */

var cached;
var NOT_REGEX = '[\\[!*+?$^"\'.\\\\/]+';
var not = createTextRegex(NOT_REGEX);

/**
 * Nanomatch parsers
 */

module.exports = function(nanomatch, options) {
  var parser = nanomatch.parser;
  var opts = parser.options;

  parser.state = {
    slashes: 0,
    paths: []
  };

  parser.ast.state = parser.state;
  parser

    /**
     * Beginning-of-string
     */

    .capture('prefix', function() {
      if (this.parsed) return;
      var m = this.match(/^\.[\\/]/);
      if (!m) return;
      this.state.strictOpen = !!this.options.strictOpen;
      this.state.addPrefix = true;
    })

    /**
     * Escape: "\\."
     */

    .capture('escape', function() {
      if (this.isInside('bracket')) return;
      var pos = this.position();
      var m = this.match(/^(?:\\(.)|([$^]))/);
      if (!m) return;

      return pos({
        type: 'escape',
        val: m[2] || m[1]
      });
    })

    /**
     * Quoted strings
     */

    .capture('quoted', function() {
      var pos = this.position();
      var m = this.match(/^["']/);
      if (!m) return;

      var quote = m[0];
      if (this.input.indexOf(quote) === -1) {
        return pos({
          type: 'escape',
          val: quote
        });
      }

      var tok = advanceTo(this.input, quote);
      this.consume(tok.len);

      return pos({
        type: 'quoted',
        val: tok.esc
      });
    })

    /**
     * Negations: "!"
     */

    .capture('not', function() {
      var parsed = this.parsed;
      var pos = this.position();
      var m = this.match(this.notRegex || /^!+/);
      if (!m) return;
      var val = m[0];

      var isNegated = (val.length % 2) === 1;
      if (parsed === '' && !isNegated) {
        val = '';
      }

      // if nothing has been parsed, we know `!` is at the start,
      // so we need to wrap the result in a negation regex
      if (parsed === '' && isNegated && this.options.nonegate !== true) {
        this.bos.val = '(?!^(?:';
        this.append = ')$).*';
        val = '';
      }
      return pos({
        type: 'not',
        val: val
      });
    })

    /**
     * Dot: "."
     */

    .capture('dot', function() {
      var parsed = this.parsed;
      var pos = this.position();
      var m = this.match(/^\.+/);
      if (!m) return;

      var val = m[0];
      this.state.dot = val === '.' && (parsed === '' || parsed.slice(-1) === '/');

      return pos({
        type: 'dot',
        dotfiles: this.state.dot,
        val: val
      });
    })

    /**
     * Plus: "+"
     */

    .capture('plus', /^\+(?!\()/)

    /**
     * Question mark: "?"
     */

    .capture('qmark', function() {
      var parsed = this.parsed;
      var pos = this.position();
      var m = this.match(/^\?+(?!\()/);
      if (!m) return;

      this.state.metachar = true;
      this.state.qmark = true;

      return pos({
        type: 'qmark',
        parsed: parsed,
        val: m[0]
      });
    })

    /**
     * Globstar: "**"
     */

    .capture('globstar', function() {
      var parsed = this.parsed;
      var pos = this.position();
      var m = this.match(/^\*{2}(?![*(])(?=[,)/]|$)/);
      if (!m) return;

      var type = opts.noglobstar !== true ? 'globstar' : 'star';
      var node = pos({type: type, parsed: parsed});
      this.state.metachar = true;

      while (this.input.slice(0, 4) === '/**/') {
        this.input = this.input.slice(3);
      }

      node.isInside = {
        brace: this.isInside('brace'),
        paren: this.isInside('paren')
      };

      if (type === 'globstar') {
        this.state.globstar = true;
        node.val = '**';

      } else {
        this.state.star = true;
        node.val = '*';
      }

      return node;
    })

    /**
     * Star: "*"
     */

    .capture('star', function() {
      var pos = this.position();
      var starRe = /^(?:\*(?![*(])|[*]{3,}(?!\()|[*]{2}(?![(/]|$)|\*(?=\*\())/;
      var m = this.match(starRe);
      if (!m) return;

      this.state.metachar = true;
      this.state.star = true;
      return pos({
        type: 'star',
        val: m[0]
      });
    })

    /**
     * Slash: "/"
     */

    .capture('slash', function() {
      var pos = this.position();
      var m = this.match(/^\//);
      if (!m) return;

      this.state.slashes++;
      return pos({
        type: 'slash',
        val: m[0]
      });
    })

    /**
     * Backslash: "\\"
     */

    .capture('backslash', function() {
      var pos = this.position();
      var m = this.match(/^\\(?![*+?(){}[\]'"])/);
      if (!m) return;

      var val = m[0];

      if (this.isInside('bracket')) {
        val = '\\';
      } else if (val.length > 1) {
        val = '\\\\';
      }

      return pos({
        type: 'backslash',
        val: val
      });
    })

    /**
     * Square: "[.]"
     */

    .capture('square', function() {
      if (this.isInside('bracket')) return;
      var pos = this.position();
      var m = this.match(/^\[([^!^\\])\]/);
      if (!m) return;

      return pos({
        type: 'square',
        val: m[1]
      });
    })

    /**
     * Brackets: "[...]" (basic, this can be overridden by other parsers)
     */

    .capture('bracket', function() {
      var pos = this.position();
      var m = this.match(/^(?:\[([!^]?)([^\]]+|\]-)(\]|[^*+?]+)|\[)/);
      if (!m) return;

      var val = m[0];
      var negated = m[1] ? '^' : '';
      var inner = (m[2] || '').replace(/\\\\+/, '\\\\');
      var close = m[3] || '';

      if (m[2] && inner.length < m[2].length) {
        val = val.replace(/\\\\+/, '\\\\');
      }

      var esc = this.input.slice(0, 2);
      if (inner === '' && esc === '\\]') {
        inner += esc;
        this.consume(2);

        var str = this.input;
        var idx = -1;
        var ch;

        while ((ch = str[++idx])) {
          this.consume(1);
          if (ch === ']') {
            close = ch;
            break;
          }
          inner += ch;
        }
      }

      return pos({
        type: 'bracket',
        val: val,
        escaped: close !== ']',
        negated: negated,
        inner: inner,
        close: close
      });
    })

    /**
     * Text
     */

    .capture('text', function() {
      if (this.isInside('bracket')) return;
      var pos = this.position();
      var m = this.match(not);
      if (!m || !m[0]) return;

      return pos({
        type: 'text',
        val: m[0]
      });
    });

  /**
   * Allow custom parsers to be passed on options
   */

  if (options && typeof options.parsers === 'function') {
    options.parsers(nanomatch.parser);
  }
};

/**
 * Advance to the next non-escaped character
 */

function advanceTo(input, endChar) {
  var ch = input.charAt(0);
  var tok = { len: 1, val: '', esc: '' };
  var idx = 0;

  function advance() {
    if (ch !== '\\') {
      tok.esc += '\\' + ch;
      tok.val += ch;
    }

    ch = input.charAt(++idx);
    tok.len++;

    if (ch === '\\') {
      advance();
      advance();
    }
  }

  while (ch && ch !== endChar) {
    advance();
  }
  return tok;
}

/**
 * Create text regex
 */

function createTextRegex(pattern) {
  if (cached) return cached;
  var opts = {contains: true, strictClose: false};
  var not = regexNot.create(pattern, opts);
  var re = toRegex('^(?:[*]\\((?=.)|' + not + ')', opts);
  return (cached = re);
}

/**
 * Expose negation string
 */

module.exports.not = NOT_REGEX;


/***/ }),

/***/ 5156:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var utils = module.exports;
var path = __nccwpck_require__(1017);

/**
 * Module dependencies
 */

var isWindows = __nccwpck_require__(9125)();
var Snapdragon = __nccwpck_require__(2403);
utils.define = __nccwpck_require__(9783);
utils.diff = __nccwpck_require__(8915);
utils.extend = __nccwpck_require__(6254);
utils.pick = __nccwpck_require__(9962);
utils.typeOf = __nccwpck_require__(5690);
utils.unique = __nccwpck_require__(340);

/**
 * Returns true if the given value is effectively an empty string
 */

utils.isEmptyString = function(val) {
  return String(val) === '' || String(val) === './';
};

/**
 * Returns true if the platform is windows, or `path.sep` is `\\`.
 * This is defined as a function to allow `path.sep` to be set in unit tests,
 * or by the user, if there is a reason to do so.
 * @return {Boolean}
 */

utils.isWindows = function() {
  return path.sep === '\\' || isWindows === true;
};

/**
 * Return the last element from an array
 */

utils.last = function(arr, n) {
  return arr[arr.length - (n || 1)];
};

/**
 * Get the `Snapdragon` instance to use
 */

utils.instantiate = function(ast, options) {
  var snapdragon;
  // if an instance was created by `.parse`, use that instance
  if (utils.typeOf(ast) === 'object' && ast.snapdragon) {
    snapdragon = ast.snapdragon;
  // if the user supplies an instance on options, use that instance
  } else if (utils.typeOf(options) === 'object' && options.snapdragon) {
    snapdragon = options.snapdragon;
  // create a new instance
  } else {
    snapdragon = new Snapdragon(options);
  }

  utils.define(snapdragon, 'parse', function(str, options) {
    var parsed = Snapdragon.prototype.parse.call(this, str, options);
    parsed.input = str;

    // escape unmatched brace/bracket/parens
    var last = this.parser.stack.pop();
    if (last && this.options.strictErrors !== true) {
      var open = last.nodes[0];
      var inner = last.nodes[1];
      if (last.type === 'bracket') {
        if (inner.val.charAt(0) === '[') {
          inner.val = '\\' + inner.val;
        }

      } else {
        open.val = '\\' + open.val;
        var sibling = open.parent.nodes[1];
        if (sibling.type === 'star') {
          sibling.loose = true;
        }
      }
    }

    // add non-enumerable parser reference
    utils.define(parsed, 'parser', this.parser);
    return parsed;
  });

  return snapdragon;
};

/**
 * Create the key to use for memoization. The key is generated
 * by iterating over the options and concatenating key-value pairs
 * to the pattern string.
 */

utils.createKey = function(pattern, options) {
  if (typeof options === 'undefined') {
    return pattern;
  }
  var key = pattern;
  for (var prop in options) {
    if (options.hasOwnProperty(prop)) {
      key += ';' + prop + '=' + String(options[prop]);
    }
  }
  return key;
};

/**
 * Cast `val` to an array
 * @return {Array}
 */

utils.arrayify = function(val) {
  if (typeof val === 'string') return [val];
  return val ? (Array.isArray(val) ? val : [val]) : [];
};

/**
 * Return true if `val` is a non-empty string
 */

utils.isString = function(val) {
  return typeof val === 'string';
};

/**
 * Return true if `val` is a non-empty string
 */

utils.isRegex = function(val) {
  return utils.typeOf(val) === 'regexp';
};

/**
 * Return true if `val` is a non-empty string
 */

utils.isObject = function(val) {
  return utils.typeOf(val) === 'object';
};

/**
 * Escape regex characters in the given string
 */

utils.escapeRegex = function(str) {
  return str.replace(/[-[\]{}()^$|*+?.\\/\s]/g, '\\$&');
};

/**
 * Combines duplicate characters in the provided `input` string.
 * @param {String} `input`
 * @returns {String}
 */

utils.combineDupes = function(input, patterns) {
  patterns = utils.arrayify(patterns).join('|').split('|');
  patterns = patterns.map(function(s) {
    return s.replace(/\\?([+*\\/])/g, '\\$1');
  });
  var substr = patterns.join('|');
  var regex = new RegExp('(' + substr + ')(?=\\1)', 'g');
  return input.replace(regex, '');
};

/**
 * Returns true if the given `str` has special characters
 */

utils.hasSpecialChars = function(str) {
  return /(?:(?:(^|\/)[!.])|[*?+()|[\]{}]|[+@]\()/.test(str);
};

/**
 * Normalize slashes in the given filepath.
 *
 * @param {String} `filepath`
 * @return {String}
 */

utils.toPosixPath = function(str) {
  return str.replace(/\\+/g, '/');
};

/**
 * Strip backslashes before special characters in a string.
 *
 * @param {String} `str`
 * @return {String}
 */

utils.unescape = function(str) {
  return utils.toPosixPath(str.replace(/\\(?=[*+?!.])/g, ''));
};

/**
 * Strip the drive letter from a windows filepath
 * @param {String} `fp`
 * @return {String}
 */

utils.stripDrive = function(fp) {
  return utils.isWindows() ? fp.replace(/^[a-z]:[\\/]+?/i, '/') : fp;
};

/**
 * Strip the prefix from a filepath
 * @param {String} `fp`
 * @return {String}
 */

utils.stripPrefix = function(str) {
  if (str.charAt(0) === '.' && (str.charAt(1) === '/' || str.charAt(1) === '\\')) {
    return str.slice(2);
  }
  return str;
};

/**
 * Returns true if `str` is a common character that doesn't need
 * to be processed to be used for matching.
 * @param {String} `str`
 * @return {Boolean}
 */

utils.isSimpleChar = function(str) {
  return str.trim() === '' || str === '.';
};

/**
 * Returns true if the given str is an escaped or
 * unescaped path character
 */

utils.isSlash = function(str) {
  return str === '/' || str === '\\/' || str === '\\' || str === '\\\\';
};

/**
 * Returns a function that returns true if the given
 * pattern matches or contains a `filepath`
 *
 * @param {String} `pattern`
 * @return {Function}
 */

utils.matchPath = function(pattern, options) {
  return (options && options.contains)
    ? utils.containsPattern(pattern, options)
    : utils.equalsPattern(pattern, options);
};

/**
 * Returns true if the given (original) filepath or unixified path are equal
 * to the given pattern.
 */

utils._equals = function(filepath, unixPath, pattern) {
  return pattern === filepath || pattern === unixPath;
};

/**
 * Returns true if the given (original) filepath or unixified path contain
 * the given pattern.
 */

utils._contains = function(filepath, unixPath, pattern) {
  return filepath.indexOf(pattern) !== -1 || unixPath.indexOf(pattern) !== -1;
};

/**
 * Returns a function that returns true if the given
 * pattern is the same as a given `filepath`
 *
 * @param {String} `pattern`
 * @return {Function}
 */

utils.equalsPattern = function(pattern, options) {
  var unixify = utils.unixify(options);
  options = options || {};

  return function fn(filepath) {
    var equal = utils._equals(filepath, unixify(filepath), pattern);
    if (equal === true || options.nocase !== true) {
      return equal;
    }
    var lower = filepath.toLowerCase();
    return utils._equals(lower, unixify(lower), pattern);
  };
};

/**
 * Returns a function that returns true if the given
 * pattern contains a `filepath`
 *
 * @param {String} `pattern`
 * @return {Function}
 */

utils.containsPattern = function(pattern, options) {
  var unixify = utils.unixify(options);
  options = options || {};

  return function(filepath) {
    var contains = utils._contains(filepath, unixify(filepath), pattern);
    if (contains === true || options.nocase !== true) {
      return contains;
    }
    var lower = filepath.toLowerCase();
    return utils._contains(lower, unixify(lower), pattern);
  };
};

/**
 * Returns a function that returns true if the given
 * regex matches the `filename` of a file path.
 *
 * @param {RegExp} `re` Matching regex
 * @return {Function}
 */

utils.matchBasename = function(re) {
  return function(filepath) {
    return re.test(filepath) || re.test(path.basename(filepath));
  };
};

/**
 * Returns the given value unchanced.
 * @return {any}
 */

utils.identity = function(val) {
  return val;
};

/**
 * Determines the filepath to return based on the provided options.
 * @return {any}
 */

utils.value = function(str, unixify, options) {
  if (options && options.unixify === false) {
    return str;
  }
  if (options && typeof options.unixify === 'function') {
    return options.unixify(str);
  }
  return unixify(str);
};

/**
 * Returns a function that normalizes slashes in a string to forward
 * slashes, strips `./` from beginning of paths, and optionally unescapes
 * special characters.
 * @return {Function}
 */

utils.unixify = function(options) {
  var opts = options || {};
  return function(filepath) {
    if (opts.stripPrefix !== false) {
      filepath = utils.stripPrefix(filepath);
    }
    if (opts.unescape === true) {
      filepath = utils.unescape(filepath);
    }
    if (opts.unixify === true || utils.isWindows()) {
      filepath = utils.toPosixPath(filepath);
    }
    return filepath;
  };
};


/***/ }),

/***/ 9783:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * define-property <https://github.com/jonschlinkert/define-property>
 *
 * Copyright (c) 2015-2018, Jon Schlinkert.
 * Released under the MIT License.
 */



var isobject = __nccwpck_require__(5509);
var isDescriptor = __nccwpck_require__(567);
var define = (typeof Reflect !== 'undefined' && Reflect.defineProperty)
  ? Reflect.defineProperty
  : Object.defineProperty;

module.exports = function defineProperty(obj, key, val) {
  if (!isobject(obj) && typeof obj !== 'function' && !Array.isArray(obj)) {
    throw new TypeError('expected an object, function, or array');
  }

  if (typeof key !== 'string') {
    throw new TypeError('expected "key" to be a string');
  }

  if (isDescriptor(val)) {
    define(obj, key, val);
    return obj;
  }

  define(obj, key, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: val
  });

  return obj;
};


/***/ }),

/***/ 6254:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var isExtendable = __nccwpck_require__(513);
var assignSymbols = __nccwpck_require__(8782);

module.exports = Object.assign || function(obj/*, objects*/) {
  if (obj === null || typeof obj === 'undefined') {
    throw new TypeError('Cannot convert undefined or null to object');
  }
  if (!isObject(obj)) {
    obj = {};
  }
  for (var i = 1; i < arguments.length; i++) {
    var val = arguments[i];
    if (isString(val)) {
      val = toObject(val);
    }
    if (isObject(val)) {
      assign(obj, val);
      assignSymbols(obj, val);
    }
  }
  return obj;
};

function assign(a, b) {
  for (var key in b) {
    if (hasOwn(b, key)) {
      a[key] = b[key];
    }
  }
}

function isString(val) {
  return (val && typeof val === 'string');
}

function toObject(str) {
  var obj = {};
  for (var i in str) {
    obj[i] = str[i];
  }
  return obj;
}

function isObject(val) {
  return (val && typeof val === 'object') || isExtendable(val);
}

/**
 * Returns true if the given `key` is an own property of `obj`.
 */

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isEnum(obj, key) {
  return Object.prototype.propertyIsEnumerable.call(obj, key);
}


/***/ }),

/***/ 513:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * is-extendable <https://github.com/jonschlinkert/is-extendable>
 *
 * Copyright (c) 2015-2017, Jon Schlinkert.
 * Released under the MIT License.
 */



var isPlainObject = __nccwpck_require__(7810);

module.exports = function isExtendable(val) {
  return isPlainObject(val) || typeof val === 'function' || Array.isArray(val);
};


/***/ }),

/***/ 5690:
/***/ ((module) => {

var toString = Object.prototype.toString;

module.exports = function kindOf(val) {
  if (val === void 0) return 'undefined';
  if (val === null) return 'null';

  var type = typeof val;
  if (type === 'boolean') return 'boolean';
  if (type === 'string') return 'string';
  if (type === 'number') return 'number';
  if (type === 'symbol') return 'symbol';
  if (type === 'function') {
    return isGeneratorFn(val) ? 'generatorfunction' : 'function';
  }

  if (isArray(val)) return 'array';
  if (isBuffer(val)) return 'buffer';
  if (isArguments(val)) return 'arguments';
  if (isDate(val)) return 'date';
  if (isError(val)) return 'error';
  if (isRegexp(val)) return 'regexp';

  switch (ctorName(val)) {
    case 'Symbol': return 'symbol';
    case 'Promise': return 'promise';

    // Set, Map, WeakSet, WeakMap
    case 'WeakMap': return 'weakmap';
    case 'WeakSet': return 'weakset';
    case 'Map': return 'map';
    case 'Set': return 'set';

    // 8-bit typed arrays
    case 'Int8Array': return 'int8array';
    case 'Uint8Array': return 'uint8array';
    case 'Uint8ClampedArray': return 'uint8clampedarray';

    // 16-bit typed arrays
    case 'Int16Array': return 'int16array';
    case 'Uint16Array': return 'uint16array';

    // 32-bit typed arrays
    case 'Int32Array': return 'int32array';
    case 'Uint32Array': return 'uint32array';
    case 'Float32Array': return 'float32array';
    case 'Float64Array': return 'float64array';
  }

  if (isGeneratorObj(val)) {
    return 'generator';
  }

  // Non-plain objects
  type = toString.call(val);
  switch (type) {
    case '[object Object]': return 'object';
    // iterators
    case '[object Map Iterator]': return 'mapiterator';
    case '[object Set Iterator]': return 'setiterator';
    case '[object String Iterator]': return 'stringiterator';
    case '[object Array Iterator]': return 'arrayiterator';
  }

  // other
  return type.slice(8, -1).toLowerCase().replace(/\s/g, '');
};

function ctorName(val) {
  return typeof val.constructor === 'function' ? val.constructor.name : null;
}

function isArray(val) {
  if (Array.isArray) return Array.isArray(val);
  return val instanceof Array;
}

function isError(val) {
  return val instanceof Error || (typeof val.message === 'string' && val.constructor && typeof val.constructor.stackTraceLimit === 'number');
}

function isDate(val) {
  if (val instanceof Date) return true;
  return typeof val.toDateString === 'function'
    && typeof val.getDate === 'function'
    && typeof val.setDate === 'function';
}

function isRegexp(val) {
  if (val instanceof RegExp) return true;
  return typeof val.flags === 'string'
    && typeof val.ignoreCase === 'boolean'
    && typeof val.multiline === 'boolean'
    && typeof val.global === 'boolean';
}

function isGeneratorFn(name, val) {
  return ctorName(name) === 'GeneratorFunction';
}

function isGeneratorObj(val) {
  return typeof val.throw === 'function'
    && typeof val.return === 'function'
    && typeof val.next === 'function';
}

function isArguments(val) {
  try {
    if (typeof val.length === 'number' && typeof val.callee === 'function') {
      return true;
    }
  } catch (err) {
    if (err.message.indexOf('callee') !== -1) {
      return true;
    }
  }
  return false;
}

/**
 * If you need to support Safari 5-7 (8-10 yr-old browser),
 * take a look at https://github.com/feross/is-buffer
 */

function isBuffer(val) {
  if (val.constructor && typeof val.constructor.isBuffer === 'function') {
    return val.constructor.isBuffer(val);
  }
  return false;
}


/***/ }),

/***/ 7978:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

var inherits = (__nccwpck_require__(3837).inherits);

var NestedError = function (message, nested) {
    this.nested = nested;

    if (message instanceof Error) {
        nested = message;
    } else if (typeof message !== 'undefined') {
        Object.defineProperty(this, 'message', {
            value: message,
            writable: true,
            enumerable: false,
            configurable: true
        });
    }

    Error.captureStackTrace(this, this.constructor);
    var oldStackDescriptor = Object.getOwnPropertyDescriptor(this, 'stack');
    var stackDescriptor = buildStackDescriptor(oldStackDescriptor, nested);
    Object.defineProperty(this, 'stack', stackDescriptor);
};

function buildStackDescriptor(oldStackDescriptor, nested) {
    if (oldStackDescriptor.get) {
        return {
            get: function () {
                var stack = oldStackDescriptor.get.call(this);
                return buildCombinedStacks(stack, this.nested);
            }
        };
    } else {
        var stack = oldStackDescriptor.value;
        return {
            value: buildCombinedStacks(stack, nested)
        };
    }
}

function buildCombinedStacks(stack, nested) {
    if (nested) {
        stack += '\nCaused By: ' + nested.stack;
    }
    return stack;
}

inherits(NestedError, Error);
NestedError.prototype.name = 'NestedError';


module.exports = NestedError;


/***/ }),

/***/ 2448:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var typeOf = __nccwpck_require__(6961);
var copyDescriptor = __nccwpck_require__(1102);
var define = __nccwpck_require__(6967);

/**
 * Copy static properties, prototype properties, and descriptors from one object to another.
 *
 * ```js
 * function App() {}
 * var proto = App.prototype;
 * App.prototype.set = function() {};
 * App.prototype.get = function() {};
 *
 * var obj = {};
 * copy(obj, proto);
 * ```
 * @param {Object} `receiver`
 * @param {Object} `provider`
 * @param {String|Array} `omit` One or more properties to omit
 * @return {Object}
 * @api public
 */

function copy(receiver, provider, omit) {
  if (!isObject(receiver)) {
    throw new TypeError('expected receiving object to be an object.');
  }
  if (!isObject(provider)) {
    throw new TypeError('expected providing object to be an object.');
  }

  var props = nativeKeys(provider);
  var keys = Object.keys(provider);
  var len = props.length;
  omit = arrayify(omit);

  while (len--) {
    var key = props[len];

    if (has(keys, key)) {
      define(receiver, key, provider[key]);
    } else if (!(key in receiver) && !has(omit, key)) {
      copyDescriptor(receiver, provider, key);
    }
  }
};

/**
 * Return true if the given value is an object or function
 */

function isObject(val) {
  return typeOf(val) === 'object' || typeof val === 'function';
}

/**
 * Returns true if an array has any of the given elements, or an
 * object has any of the give keys.
 *
 * ```js
 * has(['a', 'b', 'c'], 'c');
 * //=> true
 *
 * has(['a', 'b', 'c'], ['c', 'z']);
 * //=> true
 *
 * has({a: 'b', c: 'd'}, ['c', 'z']);
 * //=> true
 * ```
 * @param {Object} `obj`
 * @param {String|Array} `val`
 * @return {Boolean}
 */

function has(obj, val) {
  val = arrayify(val);
  var len = val.length;

  if (isObject(obj)) {
    for (var key in obj) {
      if (val.indexOf(key) > -1) {
        return true;
      }
    }

    var keys = nativeKeys(obj);
    return has(keys, val);
  }

  if (Array.isArray(obj)) {
    var arr = obj;
    while (len--) {
      if (arr.indexOf(val[len]) > -1) {
        return true;
      }
    }
    return false;
  }

  throw new TypeError('expected an array or object.');
}

/**
 * Cast the given value to an array.
 *
 * ```js
 * arrayify('foo');
 * //=> ['foo']
 *
 * arrayify(['foo']);
 * //=> ['foo']
 * ```
 *
 * @param {String|Array} `val`
 * @return {Array}
 */

function arrayify(val) {
  return val ? (Array.isArray(val) ? val : [val]) : [];
}

/**
 * Returns true if a value has a `contructor`
 *
 * ```js
 * hasConstructor({});
 * //=> true
 *
 * hasConstructor(Object.create(null));
 * //=> false
 * ```
 * @param  {Object} `value`
 * @return {Boolean}
 */

function hasConstructor(val) {
  return isObject(val) && typeof val.constructor !== 'undefined';
}

/**
 * Get the native `ownPropertyNames` from the constructor of the
 * given `object`. An empty array is returned if the object does
 * not have a constructor.
 *
 * ```js
 * nativeKeys({a: 'b', b: 'c', c: 'd'})
 * //=> ['a', 'b', 'c']
 *
 * nativeKeys(function(){})
 * //=> ['length', 'caller']
 * ```
 *
 * @param  {Object} `obj` Object that has a `constructor`.
 * @return {Array} Array of keys.
 */

function nativeKeys(val) {
  if (!hasConstructor(val)) return [];
  return Object.getOwnPropertyNames(val);
}

/**
 * Expose `copy`
 */

module.exports = copy;

/**
 * Expose `copy.has` for tests
 */

module.exports.has = has;


/***/ }),

/***/ 3178:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * object-visit <https://github.com/jonschlinkert/object-visit>
 *
 * Copyright (c) 2015, 2017, Jon Schlinkert.
 * Released under the MIT License.
 */



var isObject = __nccwpck_require__(5509);

module.exports = function visit(thisArg, method, target, val) {
  if (!isObject(thisArg) && typeof thisArg !== 'function') {
    throw new Error('object-visit expects `thisArg` to be an object.');
  }

  if (typeof method !== 'string') {
    throw new Error('object-visit expects `method` name to be a string');
  }

  if (typeof thisArg[method] !== 'function') {
    return thisArg;
  }

  var args = [].slice.call(arguments, 3);
  target = target || {};

  for (var key in target) {
    var arr = [key, target[key]].concat(args);
    thisArg[method].apply(thisArg, arr);
  }
  return thisArg;
};


/***/ }),

/***/ 9962:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * object.pick <https://github.com/jonschlinkert/object.pick>
 *
 * Copyright (c) 2014-2015 Jon Schlinkert, contributors.
 * Licensed under the MIT License
 */



var isObject = __nccwpck_require__(5509);

module.exports = function pick(obj, keys) {
  if (!isObject(obj) && typeof obj !== 'function') {
    return {};
  }

  var res = {};
  if (typeof keys === 'string') {
    if (keys in obj) {
      res[keys] = obj[keys];
    }
    return res;
  }

  var len = keys.length;
  var idx = -1;

  while (++idx < len) {
    var key = keys[idx];
    if (key in obj) {
      res[key] = obj[key];
    }
  }
  return res;
};


/***/ }),

/***/ 1223:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

var wrappy = __nccwpck_require__(2940)
module.exports = wrappy(once)
module.exports.strict = wrappy(onceStrict)

once.proto = once(function () {
  Object.defineProperty(Function.prototype, 'once', {
    value: function () {
      return once(this)
    },
    configurable: true
  })

  Object.defineProperty(Function.prototype, 'onceStrict', {
    value: function () {
      return onceStrict(this)
    },
    configurable: true
  })
})

function once (fn) {
  var f = function () {
    if (f.called) return f.value
    f.called = true
    return f.value = fn.apply(this, arguments)
  }
  f.called = false
  return f
}

function onceStrict (fn) {
  var f = function () {
    if (f.called)
      throw new Error(f.onceError)
    f.called = true
    return f.value = fn.apply(this, arguments)
  }
  var name = fn.name || 'Function wrapped with `once`'
  f.onceError = name + " shouldn't be called more than once"
  f.called = false
  return f
}


/***/ }),

/***/ 4568:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {


const pTimeout = __nccwpck_require__(6424);

const symbolAsyncIterator = Symbol.asyncIterator || '@@asyncIterator';

const normalizeEmitter = emitter => {
	const addListener = emitter.on || emitter.addListener || emitter.addEventListener;
	const removeListener = emitter.off || emitter.removeListener || emitter.removeEventListener;

	if (!addListener || !removeListener) {
		throw new TypeError('Emitter is not compatible');
	}

	return {
		addListener: addListener.bind(emitter),
		removeListener: removeListener.bind(emitter)
	};
};

const toArray = value => Array.isArray(value) ? value : [value];

const multiple = (emitter, event, options) => {
	let cancel;
	const ret = new Promise((resolve, reject) => {
		options = {
			rejectionEvents: ['error'],
			multiArgs: false,
			resolveImmediately: false,
			...options
		};

		if (!(options.count >= 0 && (options.count === Infinity || Number.isInteger(options.count)))) {
			throw new TypeError('The `count` option should be at least 0 or more');
		}

		// Allow multiple events
		const events = toArray(event);

		const items = [];
		const {addListener, removeListener} = normalizeEmitter(emitter);

		const onItem = (...args) => {
			const value = options.multiArgs ? args : args[0];

			if (options.filter && !options.filter(value)) {
				return;
			}

			items.push(value);

			if (options.count === items.length) {
				cancel();
				resolve(items);
			}
		};

		const rejectHandler = error => {
			cancel();
			reject(error);
		};

		cancel = () => {
			for (const event of events) {
				removeListener(event, onItem);
			}

			for (const rejectionEvent of options.rejectionEvents) {
				removeListener(rejectionEvent, rejectHandler);
			}
		};

		for (const event of events) {
			addListener(event, onItem);
		}

		for (const rejectionEvent of options.rejectionEvents) {
			addListener(rejectionEvent, rejectHandler);
		}

		if (options.resolveImmediately) {
			resolve(items);
		}
	});

	ret.cancel = cancel;

	if (typeof options.timeout === 'number') {
		const timeout = pTimeout(ret, options.timeout);
		timeout.cancel = cancel;
		return timeout;
	}

	return ret;
};

const pEvent = (emitter, event, options) => {
	if (typeof options === 'function') {
		options = {filter: options};
	}

	options = {
		...options,
		count: 1,
		resolveImmediately: false
	};

	const arrayPromise = multiple(emitter, event, options);
	const promise = arrayPromise.then(array => array[0]); // eslint-disable-line promise/prefer-await-to-then
	promise.cancel = arrayPromise.cancel;

	return promise;
};

module.exports = pEvent;
// TODO: Remove this for the next major release
module.exports["default"] = pEvent;

module.exports.multiple = multiple;

module.exports.iterator = (emitter, event, options) => {
	if (typeof options === 'function') {
		options = {filter: options};
	}

	// Allow multiple events
	const events = toArray(event);

	options = {
		rejectionEvents: ['error'],
		resolutionEvents: [],
		limit: Infinity,
		multiArgs: false,
		...options
	};

	const {limit} = options;
	const isValidLimit = limit >= 0 && (limit === Infinity || Number.isInteger(limit));
	if (!isValidLimit) {
		throw new TypeError('The `limit` option should be a non-negative integer or Infinity');
	}

	if (limit === 0) {
		// Return an empty async iterator to avoid any further cost
		return {
			[Symbol.asyncIterator]() {
				return this;
			},
			async next() {
				return {
					done: true,
					value: undefined
				};
			}
		};
	}

	const {addListener, removeListener} = normalizeEmitter(emitter);

	let isDone = false;
	let error;
	let hasPendingError = false;
	const nextQueue = [];
	const valueQueue = [];
	let eventCount = 0;
	let isLimitReached = false;

	const valueHandler = (...args) => {
		eventCount++;
		isLimitReached = eventCount === limit;

		const value = options.multiArgs ? args : args[0];

		if (nextQueue.length > 0) {
			const {resolve} = nextQueue.shift();

			resolve({done: false, value});

			if (isLimitReached) {
				cancel();
			}

			return;
		}

		valueQueue.push(value);

		if (isLimitReached) {
			cancel();
		}
	};

	const cancel = () => {
		isDone = true;
		for (const event of events) {
			removeListener(event, valueHandler);
		}

		for (const rejectionEvent of options.rejectionEvents) {
			removeListener(rejectionEvent, rejectHandler);
		}

		for (const resolutionEvent of options.resolutionEvents) {
			removeListener(resolutionEvent, resolveHandler);
		}

		while (nextQueue.length > 0) {
			const {resolve} = nextQueue.shift();
			resolve({done: true, value: undefined});
		}
	};

	const rejectHandler = (...args) => {
		error = options.multiArgs ? args : args[0];

		if (nextQueue.length > 0) {
			const {reject} = nextQueue.shift();
			reject(error);
		} else {
			hasPendingError = true;
		}

		cancel();
	};

	const resolveHandler = (...args) => {
		const value = options.multiArgs ? args : args[0];

		if (options.filter && !options.filter(value)) {
			return;
		}

		if (nextQueue.length > 0) {
			const {resolve} = nextQueue.shift();
			resolve({done: true, value});
		} else {
			valueQueue.push(value);
		}

		cancel();
	};

	for (const event of events) {
		addListener(event, valueHandler);
	}

	for (const rejectionEvent of options.rejectionEvents) {
		addListener(rejectionEvent, rejectHandler);
	}

	for (const resolutionEvent of options.resolutionEvents) {
		addListener(resolutionEvent, resolveHandler);
	}

	return {
		[symbolAsyncIterator]() {
			return this;
		},
		async next() {
			if (valueQueue.length > 0) {
				const value = valueQueue.shift();
				return {
					done: isDone && valueQueue.length === 0 && !isLimitReached,
					value
				};
			}

			if (hasPendingError) {
				hasPendingError = false;
				throw error;
			}

			if (isDone) {
				return {
					done: true,
					value: undefined
				};
			}

			return new Promise((resolve, reject) => nextQueue.push({resolve, reject}));
		},
		async return(value) {
			cancel();
			return {
				done: isDone,
				value
			};
		}
	};
};

module.exports.TimeoutError = pTimeout.TimeoutError;


/***/ }),

/***/ 5886:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {


const pMap = __nccwpck_require__(1855);

const pFilter = async (iterable, filterer, options) => {
	const values = await pMap(
		iterable,
		(element, index) => Promise.all([filterer(element, index), element]),
		options
	);
	return values.filter(value => Boolean(value[0])).map(value => value[1]);
};

module.exports = pFilter;
// TODO: Remove this for the next major release
module.exports["default"] = pFilter;


/***/ }),

/***/ 1330:
/***/ ((module) => {


module.exports = (promise, onFinally) => {
	onFinally = onFinally || (() => {});

	return promise.then(
		val => new Promise(resolve => {
			resolve(onFinally());
		}).then(() => val),
		err => new Promise(resolve => {
			resolve(onFinally());
		}).then(() => {
			throw err;
		})
	);
};


/***/ }),

/***/ 1855:
/***/ ((module) => {



const pMap = (iterable, mapper, options) => new Promise((resolve, reject) => {
	options = Object.assign({
		concurrency: Infinity
	}, options);

	if (typeof mapper !== 'function') {
		throw new TypeError('Mapper function is required');
	}

	const {concurrency} = options;

	if (!(typeof concurrency === 'number' && concurrency >= 1)) {
		throw new TypeError(`Expected \`concurrency\` to be a number from 1 and up, got \`${concurrency}\` (${typeof concurrency})`);
	}

	const ret = [];
	const iterator = iterable[Symbol.iterator]();
	let isRejected = false;
	let isIterableDone = false;
	let resolvingCount = 0;
	let currentIndex = 0;

	const next = () => {
		if (isRejected) {
			return;
		}

		const nextItem = iterator.next();
		const i = currentIndex;
		currentIndex++;

		if (nextItem.done) {
			isIterableDone = true;

			if (resolvingCount === 0) {
				resolve(ret);
			}

			return;
		}

		resolvingCount++;

		Promise.resolve(nextItem.value)
			.then(element => mapper(element, i))
			.then(
				value => {
					ret[i] = value;
					resolvingCount--;
					next();
				},
				error => {
					isRejected = true;
					reject(error);
				}
			);
	};

	for (let i = 0; i < concurrency; i++) {
		next();

		if (isIterableDone) {
			break;
		}
	}
});

module.exports = pMap;
// TODO: Remove this for the next major release
module.exports["default"] = pMap;


/***/ }),

/***/ 6424:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



const pFinally = __nccwpck_require__(1330);

class TimeoutError extends Error {
	constructor(message) {
		super(message);
		this.name = 'TimeoutError';
	}
}

const pTimeout = (promise, milliseconds, fallback) => new Promise((resolve, reject) => {
	if (typeof milliseconds !== 'number' || milliseconds < 0) {
		throw new TypeError('Expected `milliseconds` to be a positive number');
	}

	if (milliseconds === Infinity) {
		resolve(promise);
		return;
	}

	const timer = setTimeout(() => {
		if (typeof fallback === 'function') {
			try {
				resolve(fallback());
			} catch (error) {
				reject(error);
			}

			return;
		}

		const message = typeof fallback === 'string' ? fallback : `Promise timed out after ${milliseconds} milliseconds`;
		const timeoutError = fallback instanceof Error ? fallback : new TimeoutError(message);

		if (typeof promise.cancel === 'function') {
			promise.cancel();
		}

		reject(timeoutError);
	}, milliseconds);

	// TODO: Use native `finally` keyword when targeting Node.js 10
	pFinally(
		// eslint-disable-next-line promise/prefer-await-to-then
		promise.then(resolve, reject),
		() => {
			clearTimeout(timer);
		}
	);
});

module.exports = pTimeout;
// TODO: Remove this for the next major release
module.exports["default"] = pTimeout;

module.exports.TimeoutError = TimeoutError;


/***/ }),

/***/ 198:
/***/ ((module) => {

/*!
 * pascalcase <https://github.com/jonschlinkert/pascalcase>
 *
 * Copyright (c) 2015, Jon Schlinkert.
 * Licensed under the MIT License.
 */

function pascalcase(str) {
  if (typeof str !== 'string') {
    throw new TypeError('expected a string.');
  }
  str = str.replace(/([A-Z])/g, ' $1');
  if (str.length === 1) { return str.toUpperCase(); }
  str = str.replace(/^[\W_]+|[\W_]+$/g, '').toLowerCase();
  str = str.charAt(0).toUpperCase() + str.slice(1);
  return str.replace(/[\W_]+(\w|$)/g, function (_, ch) {
    return ch.toUpperCase();
  });
}

module.exports = pascalcase;


/***/ }),

/***/ 7610:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var path = __nccwpck_require__(1017);
var inspect = (__nccwpck_require__(3837).inspect);

function assertPath(path) {
  if (typeof path !== 'string') {
    throw new TypeError('Path must be a string. Received ' + inspect(path));
  }
}

function posix(path) {
  assertPath(path);
  if (path.length === 0)
    return '.';
  var code = path.charCodeAt(0);
  var hasRoot = (code === 47/*/*/);
  var end = -1;
  var matchedSlash = true;
  for (var i = path.length - 1; i >= 1; --i) {
    code = path.charCodeAt(i);
    if (code === 47/*/*/) {
      if (!matchedSlash) {
        end = i;
        break;
      }
    } else {
      // We saw the first non-path separator
      matchedSlash = false;
    }
  }

  if (end === -1)
    return hasRoot ? '/' : '.';
  if (hasRoot && end === 1)
    return '//';
  return path.slice(0, end);
}

function win32(path) {
  assertPath(path);
  var len = path.length;
  if (len === 0)
    return '.';
  var rootEnd = -1;
  var end = -1;
  var matchedSlash = true;
  var offset = 0;
  var code = path.charCodeAt(0);

  // Try to match a root
  if (len > 1) {
    if (code === 47/*/*/ || code === 92/*\*/) {
      // Possible UNC root

      rootEnd = offset = 1;

      code = path.charCodeAt(1);
      if (code === 47/*/*/ || code === 92/*\*/) {
        // Matched double path separator at beginning
        var j = 2;
        var last = j;
        // Match 1 or more non-path separators
        for (; j < len; ++j) {
          code = path.charCodeAt(j);
          if (code === 47/*/*/ || code === 92/*\*/)
            break;
        }
        if (j < len && j !== last) {
          // Matched!
          last = j;
          // Match 1 or more path separators
          for (; j < len; ++j) {
            code = path.charCodeAt(j);
            if (code !== 47/*/*/ && code !== 92/*\*/)
              break;
          }
          if (j < len && j !== last) {
            // Matched!
            last = j;
            // Match 1 or more non-path separators
            for (; j < len; ++j) {
              code = path.charCodeAt(j);
              if (code === 47/*/*/ || code === 92/*\*/)
                break;
            }
            if (j === len) {
              // We matched a UNC root only
              return path;
            }
            if (j !== last) {
              // We matched a UNC root with leftovers

              // Offset by 1 to include the separator after the UNC root to
              // treat it as a "normal root" on top of a (UNC) root
              rootEnd = offset = j + 1;
            }
          }
        }
      }
    } else if ((code >= 65/*A*/ && code <= 90/*Z*/) ||
               (code >= 97/*a*/ && code <= 122/*z*/)) {
      // Possible device root

      code = path.charCodeAt(1);
      if (path.charCodeAt(1) === 58/*:*/) {
        rootEnd = offset = 2;
        if (len > 2) {
          code = path.charCodeAt(2);
          if (code === 47/*/*/ || code === 92/*\*/)
            rootEnd = offset = 3;
        }
      }
    }
  } else if (code === 47/*/*/ || code === 92/*\*/) {
    return path[0];
  }

  for (var i = len - 1; i >= offset; --i) {
    code = path.charCodeAt(i);
    if (code === 47/*/*/ || code === 92/*\*/) {
      if (!matchedSlash) {
        end = i;
        break;
      }
    } else {
      // We saw the first non-path separator
      matchedSlash = false;
    }
  }

  if (end === -1) {
    if (rootEnd === -1)
      return '.';
    else
      end = rootEnd;
  }
  return path.slice(0, end);
}

module.exports = process.platform === 'win32' ? win32 : posix;
module.exports.posix = posix;
module.exports.win32 = win32;


/***/ }),

/***/ 8714:
/***/ ((module) => {



function posix(path) {
	return path.charAt(0) === '/';
}

function win32(path) {
	// https://github.com/nodejs/node/blob/b3fcc245fb25539909ef1d5eaa01dbf92e168633/lib/path.js#L56
	var splitDeviceRe = /^([a-zA-Z]:|[\\\/]{2}[^\\\/]+[\\\/]+[^\\\/]+)?([\\\/])?([\s\S]*?)$/;
	var result = splitDeviceRe.exec(path);
	var device = result[1] || '';
	var isUnc = Boolean(device && device.charAt(1) !== ':');

	// UNC paths are always absolute
	return Boolean(result[2] || isUnc);
}

module.exports = process.platform === 'win32' ? win32 : posix;
module.exports.posix = posix;
module.exports.win32 = win32;


/***/ }),

/***/ 3433:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {


const fs = __nccwpck_require__(7147);
const pify = __nccwpck_require__(8479);

function type(fn, fn2, fp) {
	if (typeof fp !== 'string') {
		return Promise.reject(new TypeError(`Expected a string, got ${typeof fp}`));
	}

	return pify(fs[fn])(fp)
		.then(stats => stats[fn2]())
		.catch(err => {
			if (err.code === 'ENOENT') {
				return false;
			}

			throw err;
		});
}

function typeSync(fn, fn2, fp) {
	if (typeof fp !== 'string') {
		throw new TypeError(`Expected a string, got ${typeof fp}`);
	}

	try {
		return fs[fn](fp)[fn2]();
	} catch (err) {
		if (err.code === 'ENOENT') {
			return false;
		}

		throw err;
	}
}

exports.file = type.bind(null, 'stat', 'isFile');
exports.dir = type.bind(null, 'stat', 'isDirectory');
exports.symlink = type.bind(null, 'lstat', 'isSymbolicLink');
exports.fileSync = typeSync.bind(null, 'statSync', 'isFile');
exports.dirSync = typeSync.bind(null, 'statSync', 'isDirectory');
exports.symlinkSync = typeSync.bind(null, 'lstatSync', 'isSymbolicLink');


/***/ }),

/***/ 8479:
/***/ ((module) => {



const processFn = (fn, opts) => function () {
	const P = opts.promiseModule;
	const args = new Array(arguments.length);

	for (let i = 0; i < arguments.length; i++) {
		args[i] = arguments[i];
	}

	return new P((resolve, reject) => {
		if (opts.errorFirst) {
			args.push(function (err, result) {
				if (opts.multiArgs) {
					const results = new Array(arguments.length - 1);

					for (let i = 1; i < arguments.length; i++) {
						results[i - 1] = arguments[i];
					}

					if (err) {
						results.unshift(err);
						reject(results);
					} else {
						resolve(results);
					}
				} else if (err) {
					reject(err);
				} else {
					resolve(result);
				}
			});
		} else {
			args.push(function (result) {
				if (opts.multiArgs) {
					const results = new Array(arguments.length - 1);

					for (let i = 0; i < arguments.length; i++) {
						results[i] = arguments[i];
					}

					resolve(results);
				} else {
					resolve(result);
				}
			});
		}

		fn.apply(this, args);
	});
};

module.exports = (obj, opts) => {
	opts = Object.assign({
		exclude: [/.+(Sync|Stream)$/],
		errorFirst: true,
		promiseModule: Promise
	}, opts);

	const filter = key => {
		const match = pattern => typeof pattern === 'string' ? key === pattern : pattern.test(key);
		return opts.include ? opts.include.some(match) : !opts.exclude.some(match);
	};

	let ret;
	if (typeof obj === 'function') {
		ret = function () {
			if (opts.excludeMain) {
				return obj.apply(this, arguments);
			}

			return processFn(obj, opts).apply(this, arguments);
		};
	} else {
		ret = Object.create(Object.getPrototypeOf(obj));
	}

	for (const key in obj) { // eslint-disable-line guard-for-in
		const x = obj[key];
		ret[key] = typeof x === 'function' && filter(key) ? processFn(x, opts) : x;
	}

	return ret;
};


/***/ }),

/***/ 4810:
/***/ ((module) => {



const processFn = (fn, options) => function (...args) {
	const P = options.promiseModule;

	return new P((resolve, reject) => {
		if (options.multiArgs) {
			args.push((...result) => {
				if (options.errorFirst) {
					if (result[0]) {
						reject(result);
					} else {
						result.shift();
						resolve(result);
					}
				} else {
					resolve(result);
				}
			});
		} else if (options.errorFirst) {
			args.push((error, result) => {
				if (error) {
					reject(error);
				} else {
					resolve(result);
				}
			});
		} else {
			args.push(resolve);
		}

		fn.apply(this, args);
	});
};

module.exports = (input, options) => {
	options = Object.assign({
		exclude: [/.+(Sync|Stream)$/],
		errorFirst: true,
		promiseModule: Promise
	}, options);

	const objType = typeof input;
	if (!(input !== null && (objType === 'object' || objType === 'function'))) {
		throw new TypeError(`Expected \`input\` to be a \`Function\` or \`Object\`, got \`${input === null ? 'null' : objType}\``);
	}

	const filter = key => {
		const match = pattern => typeof pattern === 'string' ? key === pattern : pattern.test(key);
		return options.include ? options.include.some(match) : !options.exclude.some(match);
	};

	let ret;
	if (objType === 'function') {
		ret = function (...args) {
			return options.excludeMain ? input(...args) : processFn(input, options).apply(this, args);
		};
	} else {
		ret = Object.create(Object.getPrototypeOf(input));
	}

	for (const key in input) { // eslint-disable-line guard-for-in
		const property = input[key];
		ret[key] = typeof property === 'function' && filter(key) ? processFn(property, options) : property;
	}

	return ret;
};


/***/ }),

/***/ 4504:
/***/ ((module) => {



/**
 * POSIX character classes
 */

module.exports = {
  alnum: 'a-zA-Z0-9',
  alpha: 'a-zA-Z',
  ascii: '\\x00-\\x7F',
  blank: ' \\t',
  cntrl: '\\x00-\\x1F\\x7F',
  digit: '0-9',
  graph: '\\x21-\\x7E',
  lower: 'a-z',
  print: '\\x20-\\x7E ',
  punct: '\\-!"#$%&\'()\\*+,./:;<=>?@[\\]^_`{|}~',
  space: ' \\t\\r\\n\\v\\f',
  upper: 'A-Z',
  word: 'A-Za-z0-9_',
  xdigit: 'A-Fa-f0-9'
};


/***/ }),

/***/ 2527:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var extend = __nccwpck_require__(8755);
var safe = __nccwpck_require__(5634);

/**
 * The main export is a function that takes a `pattern` string and an `options` object.
 *
 * ```js
 & var not = require('regex-not');
 & console.log(not('foo'));
 & //=> /^(?:(?!^(?:foo)$).)*$/
 * ```
 *
 * @param {String} `pattern`
 * @param {Object} `options`
 * @return {RegExp} Converts the given `pattern` to a regex using the specified `options`.
 * @api public
 */

function toRegex(pattern, options) {
  return new RegExp(toRegex.create(pattern, options));
}

/**
 * Create a regex-compatible string from the given `pattern` and `options`.
 *
 * ```js
 & var not = require('regex-not');
 & console.log(not.create('foo'));
 & //=> '^(?:(?!^(?:foo)$).)*$'
 * ```
 * @param {String} `pattern`
 * @param {Object} `options`
 * @return {String}
 * @api public
 */

toRegex.create = function(pattern, options) {
  if (typeof pattern !== 'string') {
    throw new TypeError('expected a string');
  }

  var opts = extend({}, options);
  if (opts.contains === true) {
    opts.strictNegate = false;
  }

  var open = opts.strictOpen !== false ? '^' : '';
  var close = opts.strictClose !== false ? '$' : '';
  var endChar = opts.endChar ? opts.endChar : '+';
  var str = pattern;

  if (opts.strictNegate === false) {
    str = '(?:(?!(?:' + pattern + ')).)' + endChar;
  } else {
    str = '(?:(?!^(?:' + pattern + ')$).)' + endChar;
  }

  var res = open + str + close;
  if (opts.safe === true && safe(res) === false) {
    throw new Error('potentially unsafe regular expression: ' + res);
  }

  return res;
};

/**
 * Expose `toRegex`
 */

module.exports = toRegex;


/***/ }),

/***/ 8755:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var isExtendable = __nccwpck_require__(7347);
var assignSymbols = __nccwpck_require__(8782);

module.exports = Object.assign || function(obj/*, objects*/) {
  if (obj === null || typeof obj === 'undefined') {
    throw new TypeError('Cannot convert undefined or null to object');
  }
  if (!isObject(obj)) {
    obj = {};
  }
  for (var i = 1; i < arguments.length; i++) {
    var val = arguments[i];
    if (isString(val)) {
      val = toObject(val);
    }
    if (isObject(val)) {
      assign(obj, val);
      assignSymbols(obj, val);
    }
  }
  return obj;
};

function assign(a, b) {
  for (var key in b) {
    if (hasOwn(b, key)) {
      a[key] = b[key];
    }
  }
}

function isString(val) {
  return (val && typeof val === 'string');
}

function toObject(str) {
  var obj = {};
  for (var i in str) {
    obj[i] = str[i];
  }
  return obj;
}

function isObject(val) {
  return (val && typeof val === 'object') || isExtendable(val);
}

/**
 * Returns true if the given `key` is an own property of `obj`.
 */

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isEnum(obj, key) {
  return Object.prototype.propertyIsEnumerable.call(obj, key);
}


/***/ }),

/***/ 7347:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * is-extendable <https://github.com/jonschlinkert/is-extendable>
 *
 * Copyright (c) 2015-2017, Jon Schlinkert.
 * Released under the MIT License.
 */



var isPlainObject = __nccwpck_require__(7810);

module.exports = function isExtendable(val) {
  return isPlainObject(val) || typeof val === 'function' || Array.isArray(val);
};


/***/ }),

/***/ 3301:
/***/ ((module) => {

/*!
 * repeat-element <https://github.com/jonschlinkert/repeat-element>
 *
 * Copyright (c) 2015-present, Jon Schlinkert.
 * Licensed under the MIT license.
 */



module.exports = function repeat(ele, num) {
  if (Array.prototype.fill) {
    return new Array(num).fill(ele);
  }

  var arr = new Array(num);

  for (var i = 0; i < num; i++) {
    arr[i] = ele;
  }

  return arr;
};


/***/ }),

/***/ 6976:
/***/ ((module) => {

/*!
 * repeat-string <https://github.com/jonschlinkert/repeat-string>
 *
 * Copyright (c) 2014-2015, Jon Schlinkert.
 * Licensed under the MIT License.
 */



/**
 * Results cache
 */

var res = '';
var cache;

/**
 * Expose `repeat`
 */

module.exports = repeat;

/**
 * Repeat the given `string` the specified `number`
 * of times.
 *
 * **Example:**
 *
 * ```js
 * var repeat = require('repeat-string');
 * repeat('A', 5);
 * //=> AAAAA
 * ```
 *
 * @param {String} `string` The string to repeat
 * @param {Number} `number` The number of times to repeat the string
 * @return {String} Repeated string
 * @api public
 */

function repeat(str, num) {
  if (typeof str !== 'string') {
    throw new TypeError('expected a string');
  }

  // cover common, quick use cases
  if (num === 1) return str;
  if (num === 2) return str + str;

  var max = str.length * num;
  if (cache !== str || typeof cache === 'undefined') {
    cache = str;
    res = '';
  } else if (res.length >= max) {
    return res.substr(0, max);
  }

  while (max > res.length && num > 1) {
    if (num & 1) {
      res += str;
    }

    num >>= 1;
    str += str;
  }

  res += str;
  res = res.substr(0, max);
  return res;
}


/***/ }),

/***/ 1279:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

var util      = __nccwpck_require__(5874);
var types     = __nccwpck_require__(1451);
var sets      = __nccwpck_require__(1408);
var positions = __nccwpck_require__(9177);


module.exports = function(regexpStr) {
  var i = 0, l, c,
      start = { type: types.ROOT, stack: []},

      // Keep track of last clause/group and stack.
      lastGroup = start,
      last = start.stack,
      groupStack = [];


  var repeatErr = function(i) {
    util.error(regexpStr, 'Nothing to repeat at column ' + (i - 1));
  };

  // Decode a few escaped characters.
  var str = util.strToChars(regexpStr);
  l = str.length;

  // Iterate through each character in string.
  while (i < l) {
    c = str[i++];

    switch (c) {
      // Handle escaped characters, inclues a few sets.
      case '\\':
        c = str[i++];

        switch (c) {
          case 'b':
            last.push(positions.wordBoundary());
            break;

          case 'B':
            last.push(positions.nonWordBoundary());
            break;

          case 'w':
            last.push(sets.words());
            break;

          case 'W':
            last.push(sets.notWords());
            break;

          case 'd':
            last.push(sets.ints());
            break;

          case 'D':
            last.push(sets.notInts());
            break;

          case 's':
            last.push(sets.whitespace());
            break;

          case 'S':
            last.push(sets.notWhitespace());
            break;

          default:
            // Check if c is integer.
            // In which case it's a reference.
            if (/\d/.test(c)) {
              last.push({ type: types.REFERENCE, value: parseInt(c, 10) });

            // Escaped character.
            } else {
              last.push({ type: types.CHAR, value: c.charCodeAt(0) });
            }
        }

        break;


      // Positionals.
      case '^':
          last.push(positions.begin());
        break;

      case '$':
          last.push(positions.end());
        break;


      // Handle custom sets.
      case '[':
        // Check if this class is 'anti' i.e. [^abc].
        var not;
        if (str[i] === '^') {
          not = true;
          i++;
        } else {
          not = false;
        }

        // Get all the characters in class.
        var classTokens = util.tokenizeClass(str.slice(i), regexpStr);

        // Increase index by length of class.
        i += classTokens[1];
        last.push({
          type: types.SET,
          set: classTokens[0],
          not: not,
        });

        break;


      // Class of any character except \n.
      case '.':
        last.push(sets.anyChar());
        break;


      // Push group onto stack.
      case '(':
        // Create group.
        var group = {
          type: types.GROUP,
          stack: [],
          remember: true,
        };

        c = str[i];

        // If if this is a special kind of group.
        if (c === '?') {
          c = str[i + 1];
          i += 2;

          // Match if followed by.
          if (c === '=') {
            group.followedBy = true;

          // Match if not followed by.
          } else if (c === '!') {
            group.notFollowedBy = true;

          } else if (c !== ':') {
            util.error(regexpStr,
              'Invalid group, character \'' + c +
              '\' after \'?\' at column ' + (i - 1));
          }

          group.remember = false;
        }

        // Insert subgroup into current group stack.
        last.push(group);

        // Remember the current group for when the group closes.
        groupStack.push(lastGroup);

        // Make this new group the current group.
        lastGroup = group;
        last = group.stack;
        break;


      // Pop group out of stack.
      case ')':
        if (groupStack.length === 0) {
          util.error(regexpStr, 'Unmatched ) at column ' + (i - 1));
        }
        lastGroup = groupStack.pop();

        // Check if this group has a PIPE.
        // To get back the correct last stack.
        last = lastGroup.options ?
          lastGroup.options[lastGroup.options.length - 1] : lastGroup.stack;
        break;


      // Use pipe character to give more choices.
      case '|':
        // Create array where options are if this is the first PIPE
        // in this clause.
        if (!lastGroup.options) {
          lastGroup.options = [lastGroup.stack];
          delete lastGroup.stack;
        }

        // Create a new stack and add to options for rest of clause.
        var stack = [];
        lastGroup.options.push(stack);
        last = stack;
        break;


      // Repetition.
      // For every repetition, remove last element from last stack
      // then insert back a RANGE object.
      // This design is chosen because there could be more than
      // one repetition symbols in a regex i.e. `a?+{2,3}`.
      case '{':
        var rs = /^(\d+)(,(\d+)?)?\}/.exec(str.slice(i)), min, max;
        if (rs !== null) {
          if (last.length === 0) {
            repeatErr(i);
          }
          min = parseInt(rs[1], 10);
          max = rs[2] ? rs[3] ? parseInt(rs[3], 10) : Infinity : min;
          i += rs[0].length;

          last.push({
            type: types.REPETITION,
            min: min,
            max: max,
            value: last.pop(),
          });
        } else {
          last.push({
            type: types.CHAR,
            value: 123,
          });
        }
        break;

      case '?':
        if (last.length === 0) {
          repeatErr(i);
        }
        last.push({
          type: types.REPETITION,
          min: 0,
          max: 1,
          value: last.pop(),
        });
        break;

      case '+':
        if (last.length === 0) {
          repeatErr(i);
        }
        last.push({
          type: types.REPETITION,
          min: 1,
          max: Infinity,
          value: last.pop(),
        });
        break;

      case '*':
        if (last.length === 0) {
          repeatErr(i);
        }
        last.push({
          type: types.REPETITION,
          min: 0,
          max: Infinity,
          value: last.pop(),
        });
        break;


      // Default is a character that is not `\[](){}?+*^$`.
      default:
        last.push({
          type: types.CHAR,
          value: c.charCodeAt(0),
        });
    }

  }

  // Check if any groups have not been closed.
  if (groupStack.length !== 0) {
    util.error(regexpStr, 'Unterminated group');
  }

  return start;
};

module.exports.types = types;


/***/ }),

/***/ 9177:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {

var types = __nccwpck_require__(1451);

exports.wordBoundary = function() {
  return { type: types.POSITION, value: 'b' };
};

exports.nonWordBoundary = function() {
  return { type: types.POSITION, value: 'B' };
};

exports.begin = function() {
  return { type: types.POSITION, value: '^' };
};

exports.end = function() {
  return { type: types.POSITION, value: '$' };
};


/***/ }),

/***/ 1408:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {

var types = __nccwpck_require__(1451);

var INTS = function() {
 return [{ type: types.RANGE , from: 48, to: 57 }];
};

var WORDS = function() {
 return [
    { type: types.CHAR, value: 95 },
    { type: types.RANGE, from: 97, to: 122 },
    { type: types.RANGE, from: 65, to: 90 }
  ].concat(INTS());
};

var WHITESPACE = function() {
 return [
    { type: types.CHAR, value: 9 },
    { type: types.CHAR, value: 10 },
    { type: types.CHAR, value: 11 },
    { type: types.CHAR, value: 12 },
    { type: types.CHAR, value: 13 },
    { type: types.CHAR, value: 32 },
    { type: types.CHAR, value: 160 },
    { type: types.CHAR, value: 5760 },
    { type: types.CHAR, value: 6158 },
    { type: types.CHAR, value: 8192 },
    { type: types.CHAR, value: 8193 },
    { type: types.CHAR, value: 8194 },
    { type: types.CHAR, value: 8195 },
    { type: types.CHAR, value: 8196 },
    { type: types.CHAR, value: 8197 },
    { type: types.CHAR, value: 8198 },
    { type: types.CHAR, value: 8199 },
    { type: types.CHAR, value: 8200 },
    { type: types.CHAR, value: 8201 },
    { type: types.CHAR, value: 8202 },
    { type: types.CHAR, value: 8232 },
    { type: types.CHAR, value: 8233 },
    { type: types.CHAR, value: 8239 },
    { type: types.CHAR, value: 8287 },
    { type: types.CHAR, value: 12288 },
    { type: types.CHAR, value: 65279 }
  ];
};

var NOTANYCHAR = function() {
  return [
    { type: types.CHAR, value: 10 },
    { type: types.CHAR, value: 13 },
    { type: types.CHAR, value: 8232 },
    { type: types.CHAR, value: 8233 },
  ];
};

// Predefined class objects.
exports.words = function() {
  return { type: types.SET, set: WORDS(), not: false };
};

exports.notWords = function() {
  return { type: types.SET, set: WORDS(), not: true };
};

exports.ints = function() {
  return { type: types.SET, set: INTS(), not: false };
};

exports.notInts = function() {
  return { type: types.SET, set: INTS(), not: true };
};

exports.whitespace = function() {
  return { type: types.SET, set: WHITESPACE(), not: false };
};

exports.notWhitespace = function() {
  return { type: types.SET, set: WHITESPACE(), not: true };
};

exports.anyChar = function() {
  return { type: types.SET, set: NOTANYCHAR(), not: true };
};


/***/ }),

/***/ 1451:
/***/ ((module) => {

module.exports = {
  ROOT       : 0,
  GROUP      : 1,
  POSITION   : 2,
  SET        : 3,
  RANGE      : 4,
  REPETITION : 5,
  REFERENCE  : 6,
  CHAR       : 7,
};


/***/ }),

/***/ 5874:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {

var types = __nccwpck_require__(1451);
var sets  = __nccwpck_require__(1408);


// All of these are private and only used by randexp.
// It's assumed that they will always be called with the correct input.

var CTRL = '@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^ ?';
var SLSH = { '0': 0, 't': 9, 'n': 10, 'v': 11, 'f': 12, 'r': 13 };

/**
 * Finds character representations in str and convert all to
 * their respective characters
 *
 * @param {String} str
 * @return {String}
 */
exports.strToChars = function(str) {
  /* jshint maxlen: false */
  var chars_regex = /(\[\\b\])|(\\)?\\(?:u([A-F0-9]{4})|x([A-F0-9]{2})|(0?[0-7]{2})|c([@A-Z\[\\\]\^?])|([0tnvfr]))/g;
  str = str.replace(chars_regex, function(s, b, lbs, a16, b16, c8, dctrl, eslsh) {
    if (lbs) {
      return s;
    }

    var code = b     ? 8 :
               a16   ? parseInt(a16, 16) :
               b16   ? parseInt(b16, 16) :
               c8    ? parseInt(c8,   8) :
               dctrl ? CTRL.indexOf(dctrl) :
               SLSH[eslsh];

    var c = String.fromCharCode(code);

    // Escape special regex characters.
    if (/[\[\]{}\^$.|?*+()]/.test(c)) {
      c = '\\' + c;
    }

    return c;
  });

  return str;
};


/**
 * turns class into tokens
 * reads str until it encounters a ] not preceeded by a \
 *
 * @param {String} str
 * @param {String} regexpStr
 * @return {Array.<Array.<Object>, Number>}
 */
exports.tokenizeClass = function(str, regexpStr) {
  /* jshint maxlen: false */
  var tokens = [];
  var regexp = /\\(?:(w)|(d)|(s)|(W)|(D)|(S))|((?:(?:\\)(.)|([^\]\\]))-(?:\\)?([^\]]))|(\])|(?:\\)?(.)/g;
  var rs, c;


  while ((rs = regexp.exec(str)) != null) {
    if (rs[1]) {
      tokens.push(sets.words());

    } else if (rs[2]) {
      tokens.push(sets.ints());

    } else if (rs[3]) {
      tokens.push(sets.whitespace());

    } else if (rs[4]) {
      tokens.push(sets.notWords());

    } else if (rs[5]) {
      tokens.push(sets.notInts());

    } else if (rs[6]) {
      tokens.push(sets.notWhitespace());

    } else if (rs[7]) {
      tokens.push({
        type: types.RANGE,
        from: (rs[8] || rs[9]).charCodeAt(0),
          to: rs[10].charCodeAt(0),
      });

    } else if (c = rs[12]) {
      tokens.push({
        type: types.CHAR,
        value: c.charCodeAt(0),
      });

    } else {
      return [tokens, regexp.lastIndex];
    }
  }

  exports.error(regexpStr, 'Unterminated character class');
};


/**
 * Shortcut to throw errors.
 *
 * @param {String} regexp
 * @param {String} msg
 */
exports.error = function(regexp, msg) {
  throw new SyntaxError('Invalid regular expression: /' + regexp + '/: ' + msg);
};


/***/ }),

/***/ 5634:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

var parse = __nccwpck_require__(1279);
var types = parse.types;

module.exports = function (re, opts) {
    if (!opts) opts = {};
    var replimit = opts.limit === undefined ? 25 : opts.limit;
    
    if (isRegExp(re)) re = re.source;
    else if (typeof re !== 'string') re = String(re);
    
    try { re = parse(re) }
    catch (err) { return false }
    
    var reps = 0;
    return (function walk (node, starHeight) {
        if (node.type === types.REPETITION) {
            starHeight ++;
            reps ++;
            if (starHeight > 1) return false;
            if (reps > replimit) return false;
        }
        
        if (node.options) {
            for (var i = 0, len = node.options.length; i < len; i++) {
                var ok = walk({ stack: node.options[i] }, starHeight);
                if (!ok) return false;
            }
        }
        var stack = node.stack || (node.value && node.value.stack);
        if (!stack) return true;
        
        for (var i = 0; i < stack.length; i++) {
            var ok = walk(stack[i], starHeight);
            if (!ok) return false;
        }
        
        return true;
    })(re, 0);
};

function isRegExp (x) {
    return {}.toString.call(x) === '[object RegExp]';
}


/***/ }),

/***/ 5911:
/***/ ((module, exports) => {

exports = module.exports = SemVer

var debug
/* istanbul ignore next */
if (typeof process === 'object' &&
    process.env &&
    process.env.NODE_DEBUG &&
    /\bsemver\b/i.test(process.env.NODE_DEBUG)) {
  debug = function () {
    var args = Array.prototype.slice.call(arguments, 0)
    args.unshift('SEMVER')
    console.log.apply(console, args)
  }
} else {
  debug = function () {}
}

// Note: this is the semver.org version of the spec that it implements
// Not necessarily the package version of this code.
exports.SEMVER_SPEC_VERSION = '2.0.0'

var MAX_LENGTH = 256
var MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER ||
  /* istanbul ignore next */ 9007199254740991

// Max safe segment length for coercion.
var MAX_SAFE_COMPONENT_LENGTH = 16

// The actual regexps go on exports.re
var re = exports.re = []
var src = exports.src = []
var t = exports.tokens = {}
var R = 0

function tok (n) {
  t[n] = R++
}

// The following Regular Expressions can be used for tokenizing,
// validating, and parsing SemVer version strings.

// ## Numeric Identifier
// A single `0`, or a non-zero digit followed by zero or more digits.

tok('NUMERICIDENTIFIER')
src[t.NUMERICIDENTIFIER] = '0|[1-9]\\d*'
tok('NUMERICIDENTIFIERLOOSE')
src[t.NUMERICIDENTIFIERLOOSE] = '[0-9]+'

// ## Non-numeric Identifier
// Zero or more digits, followed by a letter or hyphen, and then zero or
// more letters, digits, or hyphens.

tok('NONNUMERICIDENTIFIER')
src[t.NONNUMERICIDENTIFIER] = '\\d*[a-zA-Z-][a-zA-Z0-9-]*'

// ## Main Version
// Three dot-separated numeric identifiers.

tok('MAINVERSION')
src[t.MAINVERSION] = '(' + src[t.NUMERICIDENTIFIER] + ')\\.' +
                   '(' + src[t.NUMERICIDENTIFIER] + ')\\.' +
                   '(' + src[t.NUMERICIDENTIFIER] + ')'

tok('MAINVERSIONLOOSE')
src[t.MAINVERSIONLOOSE] = '(' + src[t.NUMERICIDENTIFIERLOOSE] + ')\\.' +
                        '(' + src[t.NUMERICIDENTIFIERLOOSE] + ')\\.' +
                        '(' + src[t.NUMERICIDENTIFIERLOOSE] + ')'

// ## Pre-release Version Identifier
// A numeric identifier, or a non-numeric identifier.

tok('PRERELEASEIDENTIFIER')
src[t.PRERELEASEIDENTIFIER] = '(?:' + src[t.NUMERICIDENTIFIER] +
                            '|' + src[t.NONNUMERICIDENTIFIER] + ')'

tok('PRERELEASEIDENTIFIERLOOSE')
src[t.PRERELEASEIDENTIFIERLOOSE] = '(?:' + src[t.NUMERICIDENTIFIERLOOSE] +
                                 '|' + src[t.NONNUMERICIDENTIFIER] + ')'

// ## Pre-release Version
// Hyphen, followed by one or more dot-separated pre-release version
// identifiers.

tok('PRERELEASE')
src[t.PRERELEASE] = '(?:-(' + src[t.PRERELEASEIDENTIFIER] +
                  '(?:\\.' + src[t.PRERELEASEIDENTIFIER] + ')*))'

tok('PRERELEASELOOSE')
src[t.PRERELEASELOOSE] = '(?:-?(' + src[t.PRERELEASEIDENTIFIERLOOSE] +
                       '(?:\\.' + src[t.PRERELEASEIDENTIFIERLOOSE] + ')*))'

// ## Build Metadata Identifier
// Any combination of digits, letters, or hyphens.

tok('BUILDIDENTIFIER')
src[t.BUILDIDENTIFIER] = '[0-9A-Za-z-]+'

// ## Build Metadata
// Plus sign, followed by one or more period-separated build metadata
// identifiers.

tok('BUILD')
src[t.BUILD] = '(?:\\+(' + src[t.BUILDIDENTIFIER] +
             '(?:\\.' + src[t.BUILDIDENTIFIER] + ')*))'

// ## Full Version String
// A main version, followed optionally by a pre-release version and
// build metadata.

// Note that the only major, minor, patch, and pre-release sections of
// the version string are capturing groups.  The build metadata is not a
// capturing group, because it should not ever be used in version
// comparison.

tok('FULL')
tok('FULLPLAIN')
src[t.FULLPLAIN] = 'v?' + src[t.MAINVERSION] +
                  src[t.PRERELEASE] + '?' +
                  src[t.BUILD] + '?'

src[t.FULL] = '^' + src[t.FULLPLAIN] + '$'

// like full, but allows v1.2.3 and =1.2.3, which people do sometimes.
// also, 1.0.0alpha1 (prerelease without the hyphen) which is pretty
// common in the npm registry.
tok('LOOSEPLAIN')
src[t.LOOSEPLAIN] = '[v=\\s]*' + src[t.MAINVERSIONLOOSE] +
                  src[t.PRERELEASELOOSE] + '?' +
                  src[t.BUILD] + '?'

tok('LOOSE')
src[t.LOOSE] = '^' + src[t.LOOSEPLAIN] + '$'

tok('GTLT')
src[t.GTLT] = '((?:<|>)?=?)'

// Something like "2.*" or "1.2.x".
// Note that "x.x" is a valid xRange identifer, meaning "any version"
// Only the first item is strictly required.
tok('XRANGEIDENTIFIERLOOSE')
src[t.XRANGEIDENTIFIERLOOSE] = src[t.NUMERICIDENTIFIERLOOSE] + '|x|X|\\*'
tok('XRANGEIDENTIFIER')
src[t.XRANGEIDENTIFIER] = src[t.NUMERICIDENTIFIER] + '|x|X|\\*'

tok('XRANGEPLAIN')
src[t.XRANGEPLAIN] = '[v=\\s]*(' + src[t.XRANGEIDENTIFIER] + ')' +
                   '(?:\\.(' + src[t.XRANGEIDENTIFIER] + ')' +
                   '(?:\\.(' + src[t.XRANGEIDENTIFIER] + ')' +
                   '(?:' + src[t.PRERELEASE] + ')?' +
                   src[t.BUILD] + '?' +
                   ')?)?'

tok('XRANGEPLAINLOOSE')
src[t.XRANGEPLAINLOOSE] = '[v=\\s]*(' + src[t.XRANGEIDENTIFIERLOOSE] + ')' +
                        '(?:\\.(' + src[t.XRANGEIDENTIFIERLOOSE] + ')' +
                        '(?:\\.(' + src[t.XRANGEIDENTIFIERLOOSE] + ')' +
                        '(?:' + src[t.PRERELEASELOOSE] + ')?' +
                        src[t.BUILD] + '?' +
                        ')?)?'

tok('XRANGE')
src[t.XRANGE] = '^' + src[t.GTLT] + '\\s*' + src[t.XRANGEPLAIN] + '$'
tok('XRANGELOOSE')
src[t.XRANGELOOSE] = '^' + src[t.GTLT] + '\\s*' + src[t.XRANGEPLAINLOOSE] + '$'

// Coercion.
// Extract anything that could conceivably be a part of a valid semver
tok('COERCE')
src[t.COERCE] = '(^|[^\\d])' +
              '(\\d{1,' + MAX_SAFE_COMPONENT_LENGTH + '})' +
              '(?:\\.(\\d{1,' + MAX_SAFE_COMPONENT_LENGTH + '}))?' +
              '(?:\\.(\\d{1,' + MAX_SAFE_COMPONENT_LENGTH + '}))?' +
              '(?:$|[^\\d])'
tok('COERCERTL')
re[t.COERCERTL] = new RegExp(src[t.COERCE], 'g')

// Tilde ranges.
// Meaning is "reasonably at or greater than"
tok('LONETILDE')
src[t.LONETILDE] = '(?:~>?)'

tok('TILDETRIM')
src[t.TILDETRIM] = '(\\s*)' + src[t.LONETILDE] + '\\s+'
re[t.TILDETRIM] = new RegExp(src[t.TILDETRIM], 'g')
var tildeTrimReplace = '$1~'

tok('TILDE')
src[t.TILDE] = '^' + src[t.LONETILDE] + src[t.XRANGEPLAIN] + '$'
tok('TILDELOOSE')
src[t.TILDELOOSE] = '^' + src[t.LONETILDE] + src[t.XRANGEPLAINLOOSE] + '$'

// Caret ranges.
// Meaning is "at least and backwards compatible with"
tok('LONECARET')
src[t.LONECARET] = '(?:\\^)'

tok('CARETTRIM')
src[t.CARETTRIM] = '(\\s*)' + src[t.LONECARET] + '\\s+'
re[t.CARETTRIM] = new RegExp(src[t.CARETTRIM], 'g')
var caretTrimReplace = '$1^'

tok('CARET')
src[t.CARET] = '^' + src[t.LONECARET] + src[t.XRANGEPLAIN] + '$'
tok('CARETLOOSE')
src[t.CARETLOOSE] = '^' + src[t.LONECARET] + src[t.XRANGEPLAINLOOSE] + '$'

// A simple gt/lt/eq thing, or just "" to indicate "any version"
tok('COMPARATORLOOSE')
src[t.COMPARATORLOOSE] = '^' + src[t.GTLT] + '\\s*(' + src[t.LOOSEPLAIN] + ')$|^$'
tok('COMPARATOR')
src[t.COMPARATOR] = '^' + src[t.GTLT] + '\\s*(' + src[t.FULLPLAIN] + ')$|^$'

// An expression to strip any whitespace between the gtlt and the thing
// it modifies, so that `> 1.2.3` ==> `>1.2.3`
tok('COMPARATORTRIM')
src[t.COMPARATORTRIM] = '(\\s*)' + src[t.GTLT] +
                      '\\s*(' + src[t.LOOSEPLAIN] + '|' + src[t.XRANGEPLAIN] + ')'

// this one has to use the /g flag
re[t.COMPARATORTRIM] = new RegExp(src[t.COMPARATORTRIM], 'g')
var comparatorTrimReplace = '$1$2$3'

// Something like `1.2.3 - 1.2.4`
// Note that these all use the loose form, because they'll be
// checked against either the strict or loose comparator form
// later.
tok('HYPHENRANGE')
src[t.HYPHENRANGE] = '^\\s*(' + src[t.XRANGEPLAIN] + ')' +
                   '\\s+-\\s+' +
                   '(' + src[t.XRANGEPLAIN] + ')' +
                   '\\s*$'

tok('HYPHENRANGELOOSE')
src[t.HYPHENRANGELOOSE] = '^\\s*(' + src[t.XRANGEPLAINLOOSE] + ')' +
                        '\\s+-\\s+' +
                        '(' + src[t.XRANGEPLAINLOOSE] + ')' +
                        '\\s*$'

// Star ranges basically just allow anything at all.
tok('STAR')
src[t.STAR] = '(<|>)?=?\\s*\\*'

// Compile to actual regexp objects.
// All are flag-free, unless they were created above with a flag.
for (var i = 0; i < R; i++) {
  debug(i, src[i])
  if (!re[i]) {
    re[i] = new RegExp(src[i])
  }
}

exports.parse = parse
function parse (version, options) {
  if (!options || typeof options !== 'object') {
    options = {
      loose: !!options,
      includePrerelease: false
    }
  }

  if (version instanceof SemVer) {
    return version
  }

  if (typeof version !== 'string') {
    return null
  }

  if (version.length > MAX_LENGTH) {
    return null
  }

  var r = options.loose ? re[t.LOOSE] : re[t.FULL]
  if (!r.test(version)) {
    return null
  }

  try {
    return new SemVer(version, options)
  } catch (er) {
    return null
  }
}

exports.valid = valid
function valid (version, options) {
  var v = parse(version, options)
  return v ? v.version : null
}

exports.clean = clean
function clean (version, options) {
  var s = parse(version.trim().replace(/^[=v]+/, ''), options)
  return s ? s.version : null
}

exports.SemVer = SemVer

function SemVer (version, options) {
  if (!options || typeof options !== 'object') {
    options = {
      loose: !!options,
      includePrerelease: false
    }
  }
  if (version instanceof SemVer) {
    if (version.loose === options.loose) {
      return version
    } else {
      version = version.version
    }
  } else if (typeof version !== 'string') {
    throw new TypeError('Invalid Version: ' + version)
  }

  if (version.length > MAX_LENGTH) {
    throw new TypeError('version is longer than ' + MAX_LENGTH + ' characters')
  }

  if (!(this instanceof SemVer)) {
    return new SemVer(version, options)
  }

  debug('SemVer', version, options)
  this.options = options
  this.loose = !!options.loose

  var m = version.trim().match(options.loose ? re[t.LOOSE] : re[t.FULL])

  if (!m) {
    throw new TypeError('Invalid Version: ' + version)
  }

  this.raw = version

  // these are actually numbers
  this.major = +m[1]
  this.minor = +m[2]
  this.patch = +m[3]

  if (this.major > MAX_SAFE_INTEGER || this.major < 0) {
    throw new TypeError('Invalid major version')
  }

  if (this.minor > MAX_SAFE_INTEGER || this.minor < 0) {
    throw new TypeError('Invalid minor version')
  }

  if (this.patch > MAX_SAFE_INTEGER || this.patch < 0) {
    throw new TypeError('Invalid patch version')
  }

  // numberify any prerelease numeric ids
  if (!m[4]) {
    this.prerelease = []
  } else {
    this.prerelease = m[4].split('.').map(function (id) {
      if (/^[0-9]+$/.test(id)) {
        var num = +id
        if (num >= 0 && num < MAX_SAFE_INTEGER) {
          return num
        }
      }
      return id
    })
  }

  this.build = m[5] ? m[5].split('.') : []
  this.format()
}

SemVer.prototype.format = function () {
  this.version = this.major + '.' + this.minor + '.' + this.patch
  if (this.prerelease.length) {
    this.version += '-' + this.prerelease.join('.')
  }
  return this.version
}

SemVer.prototype.toString = function () {
  return this.version
}

SemVer.prototype.compare = function (other) {
  debug('SemVer.compare', this.version, this.options, other)
  if (!(other instanceof SemVer)) {
    other = new SemVer(other, this.options)
  }

  return this.compareMain(other) || this.comparePre(other)
}

SemVer.prototype.compareMain = function (other) {
  if (!(other instanceof SemVer)) {
    other = new SemVer(other, this.options)
  }

  return compareIdentifiers(this.major, other.major) ||
         compareIdentifiers(this.minor, other.minor) ||
         compareIdentifiers(this.patch, other.patch)
}

SemVer.prototype.comparePre = function (other) {
  if (!(other instanceof SemVer)) {
    other = new SemVer(other, this.options)
  }

  // NOT having a prerelease is > having one
  if (this.prerelease.length && !other.prerelease.length) {
    return -1
  } else if (!this.prerelease.length && other.prerelease.length) {
    return 1
  } else if (!this.prerelease.length && !other.prerelease.length) {
    return 0
  }

  var i = 0
  do {
    var a = this.prerelease[i]
    var b = other.prerelease[i]
    debug('prerelease compare', i, a, b)
    if (a === undefined && b === undefined) {
      return 0
    } else if (b === undefined) {
      return 1
    } else if (a === undefined) {
      return -1
    } else if (a === b) {
      continue
    } else {
      return compareIdentifiers(a, b)
    }
  } while (++i)
}

SemVer.prototype.compareBuild = function (other) {
  if (!(other instanceof SemVer)) {
    other = new SemVer(other, this.options)
  }

  var i = 0
  do {
    var a = this.build[i]
    var b = other.build[i]
    debug('prerelease compare', i, a, b)
    if (a === undefined && b === undefined) {
      return 0
    } else if (b === undefined) {
      return 1
    } else if (a === undefined) {
      return -1
    } else if (a === b) {
      continue
    } else {
      return compareIdentifiers(a, b)
    }
  } while (++i)
}

// preminor will bump the version up to the next minor release, and immediately
// down to pre-release. premajor and prepatch work the same way.
SemVer.prototype.inc = function (release, identifier) {
  switch (release) {
    case 'premajor':
      this.prerelease.length = 0
      this.patch = 0
      this.minor = 0
      this.major++
      this.inc('pre', identifier)
      break
    case 'preminor':
      this.prerelease.length = 0
      this.patch = 0
      this.minor++
      this.inc('pre', identifier)
      break
    case 'prepatch':
      // If this is already a prerelease, it will bump to the next version
      // drop any prereleases that might already exist, since they are not
      // relevant at this point.
      this.prerelease.length = 0
      this.inc('patch', identifier)
      this.inc('pre', identifier)
      break
    // If the input is a non-prerelease version, this acts the same as
    // prepatch.
    case 'prerelease':
      if (this.prerelease.length === 0) {
        this.inc('patch', identifier)
      }
      this.inc('pre', identifier)
      break

    case 'major':
      // If this is a pre-major version, bump up to the same major version.
      // Otherwise increment major.
      // 1.0.0-5 bumps to 1.0.0
      // 1.1.0 bumps to 2.0.0
      if (this.minor !== 0 ||
          this.patch !== 0 ||
          this.prerelease.length === 0) {
        this.major++
      }
      this.minor = 0
      this.patch = 0
      this.prerelease = []
      break
    case 'minor':
      // If this is a pre-minor version, bump up to the same minor version.
      // Otherwise increment minor.
      // 1.2.0-5 bumps to 1.2.0
      // 1.2.1 bumps to 1.3.0
      if (this.patch !== 0 || this.prerelease.length === 0) {
        this.minor++
      }
      this.patch = 0
      this.prerelease = []
      break
    case 'patch':
      // If this is not a pre-release version, it will increment the patch.
      // If it is a pre-release it will bump up to the same patch version.
      // 1.2.0-5 patches to 1.2.0
      // 1.2.0 patches to 1.2.1
      if (this.prerelease.length === 0) {
        this.patch++
      }
      this.prerelease = []
      break
    // This probably shouldn't be used publicly.
    // 1.0.0 "pre" would become 1.0.0-0 which is the wrong direction.
    case 'pre':
      if (this.prerelease.length === 0) {
        this.prerelease = [0]
      } else {
        var i = this.prerelease.length
        while (--i >= 0) {
          if (typeof this.prerelease[i] === 'number') {
            this.prerelease[i]++
            i = -2
          }
        }
        if (i === -1) {
          // didn't increment anything
          this.prerelease.push(0)
        }
      }
      if (identifier) {
        // 1.2.0-beta.1 bumps to 1.2.0-beta.2,
        // 1.2.0-beta.fooblz or 1.2.0-beta bumps to 1.2.0-beta.0
        if (this.prerelease[0] === identifier) {
          if (isNaN(this.prerelease[1])) {
            this.prerelease = [identifier, 0]
          }
        } else {
          this.prerelease = [identifier, 0]
        }
      }
      break

    default:
      throw new Error('invalid increment argument: ' + release)
  }
  this.format()
  this.raw = this.version
  return this
}

exports.inc = inc
function inc (version, release, loose, identifier) {
  if (typeof (loose) === 'string') {
    identifier = loose
    loose = undefined
  }

  try {
    return new SemVer(version, loose).inc(release, identifier).version
  } catch (er) {
    return null
  }
}

exports.diff = diff
function diff (version1, version2) {
  if (eq(version1, version2)) {
    return null
  } else {
    var v1 = parse(version1)
    var v2 = parse(version2)
    var prefix = ''
    if (v1.prerelease.length || v2.prerelease.length) {
      prefix = 'pre'
      var defaultResult = 'prerelease'
    }
    for (var key in v1) {
      if (key === 'major' || key === 'minor' || key === 'patch') {
        if (v1[key] !== v2[key]) {
          return prefix + key
        }
      }
    }
    return defaultResult // may be undefined
  }
}

exports.compareIdentifiers = compareIdentifiers

var numeric = /^[0-9]+$/
function compareIdentifiers (a, b) {
  var anum = numeric.test(a)
  var bnum = numeric.test(b)

  if (anum && bnum) {
    a = +a
    b = +b
  }

  return a === b ? 0
    : (anum && !bnum) ? -1
    : (bnum && !anum) ? 1
    : a < b ? -1
    : 1
}

exports.rcompareIdentifiers = rcompareIdentifiers
function rcompareIdentifiers (a, b) {
  return compareIdentifiers(b, a)
}

exports.major = major
function major (a, loose) {
  return new SemVer(a, loose).major
}

exports.minor = minor
function minor (a, loose) {
  return new SemVer(a, loose).minor
}

exports.patch = patch
function patch (a, loose) {
  return new SemVer(a, loose).patch
}

exports.compare = compare
function compare (a, b, loose) {
  return new SemVer(a, loose).compare(new SemVer(b, loose))
}

exports.compareLoose = compareLoose
function compareLoose (a, b) {
  return compare(a, b, true)
}

exports.compareBuild = compareBuild
function compareBuild (a, b, loose) {
  var versionA = new SemVer(a, loose)
  var versionB = new SemVer(b, loose)
  return versionA.compare(versionB) || versionA.compareBuild(versionB)
}

exports.rcompare = rcompare
function rcompare (a, b, loose) {
  return compare(b, a, loose)
}

exports.sort = sort
function sort (list, loose) {
  return list.sort(function (a, b) {
    return exports.compareBuild(a, b, loose)
  })
}

exports.rsort = rsort
function rsort (list, loose) {
  return list.sort(function (a, b) {
    return exports.compareBuild(b, a, loose)
  })
}

exports.gt = gt
function gt (a, b, loose) {
  return compare(a, b, loose) > 0
}

exports.lt = lt
function lt (a, b, loose) {
  return compare(a, b, loose) < 0
}

exports.eq = eq
function eq (a, b, loose) {
  return compare(a, b, loose) === 0
}

exports.neq = neq
function neq (a, b, loose) {
  return compare(a, b, loose) !== 0
}

exports.gte = gte
function gte (a, b, loose) {
  return compare(a, b, loose) >= 0
}

exports.lte = lte
function lte (a, b, loose) {
  return compare(a, b, loose) <= 0
}

exports.cmp = cmp
function cmp (a, op, b, loose) {
  switch (op) {
    case '===':
      if (typeof a === 'object')
        a = a.version
      if (typeof b === 'object')
        b = b.version
      return a === b

    case '!==':
      if (typeof a === 'object')
        a = a.version
      if (typeof b === 'object')
        b = b.version
      return a !== b

    case '':
    case '=':
    case '==':
      return eq(a, b, loose)

    case '!=':
      return neq(a, b, loose)

    case '>':
      return gt(a, b, loose)

    case '>=':
      return gte(a, b, loose)

    case '<':
      return lt(a, b, loose)

    case '<=':
      return lte(a, b, loose)

    default:
      throw new TypeError('Invalid operator: ' + op)
  }
}

exports.Comparator = Comparator
function Comparator (comp, options) {
  if (!options || typeof options !== 'object') {
    options = {
      loose: !!options,
      includePrerelease: false
    }
  }

  if (comp instanceof Comparator) {
    if (comp.loose === !!options.loose) {
      return comp
    } else {
      comp = comp.value
    }
  }

  if (!(this instanceof Comparator)) {
    return new Comparator(comp, options)
  }

  debug('comparator', comp, options)
  this.options = options
  this.loose = !!options.loose
  this.parse(comp)

  if (this.semver === ANY) {
    this.value = ''
  } else {
    this.value = this.operator + this.semver.version
  }

  debug('comp', this)
}

var ANY = {}
Comparator.prototype.parse = function (comp) {
  var r = this.options.loose ? re[t.COMPARATORLOOSE] : re[t.COMPARATOR]
  var m = comp.match(r)

  if (!m) {
    throw new TypeError('Invalid comparator: ' + comp)
  }

  this.operator = m[1] !== undefined ? m[1] : ''
  if (this.operator === '=') {
    this.operator = ''
  }

  // if it literally is just '>' or '' then allow anything.
  if (!m[2]) {
    this.semver = ANY
  } else {
    this.semver = new SemVer(m[2], this.options.loose)
  }
}

Comparator.prototype.toString = function () {
  return this.value
}

Comparator.prototype.test = function (version) {
  debug('Comparator.test', version, this.options.loose)

  if (this.semver === ANY || version === ANY) {
    return true
  }

  if (typeof version === 'string') {
    try {
      version = new SemVer(version, this.options)
    } catch (er) {
      return false
    }
  }

  return cmp(version, this.operator, this.semver, this.options)
}

Comparator.prototype.intersects = function (comp, options) {
  if (!(comp instanceof Comparator)) {
    throw new TypeError('a Comparator is required')
  }

  if (!options || typeof options !== 'object') {
    options = {
      loose: !!options,
      includePrerelease: false
    }
  }

  var rangeTmp

  if (this.operator === '') {
    if (this.value === '') {
      return true
    }
    rangeTmp = new Range(comp.value, options)
    return satisfies(this.value, rangeTmp, options)
  } else if (comp.operator === '') {
    if (comp.value === '') {
      return true
    }
    rangeTmp = new Range(this.value, options)
    return satisfies(comp.semver, rangeTmp, options)
  }

  var sameDirectionIncreasing =
    (this.operator === '>=' || this.operator === '>') &&
    (comp.operator === '>=' || comp.operator === '>')
  var sameDirectionDecreasing =
    (this.operator === '<=' || this.operator === '<') &&
    (comp.operator === '<=' || comp.operator === '<')
  var sameSemVer = this.semver.version === comp.semver.version
  var differentDirectionsInclusive =
    (this.operator === '>=' || this.operator === '<=') &&
    (comp.operator === '>=' || comp.operator === '<=')
  var oppositeDirectionsLessThan =
    cmp(this.semver, '<', comp.semver, options) &&
    ((this.operator === '>=' || this.operator === '>') &&
    (comp.operator === '<=' || comp.operator === '<'))
  var oppositeDirectionsGreaterThan =
    cmp(this.semver, '>', comp.semver, options) &&
    ((this.operator === '<=' || this.operator === '<') &&
    (comp.operator === '>=' || comp.operator === '>'))

  return sameDirectionIncreasing || sameDirectionDecreasing ||
    (sameSemVer && differentDirectionsInclusive) ||
    oppositeDirectionsLessThan || oppositeDirectionsGreaterThan
}

exports.Range = Range
function Range (range, options) {
  if (!options || typeof options !== 'object') {
    options = {
      loose: !!options,
      includePrerelease: false
    }
  }

  if (range instanceof Range) {
    if (range.loose === !!options.loose &&
        range.includePrerelease === !!options.includePrerelease) {
      return range
    } else {
      return new Range(range.raw, options)
    }
  }

  if (range instanceof Comparator) {
    return new Range(range.value, options)
  }

  if (!(this instanceof Range)) {
    return new Range(range, options)
  }

  this.options = options
  this.loose = !!options.loose
  this.includePrerelease = !!options.includePrerelease

  // First, split based on boolean or ||
  this.raw = range
  this.set = range.split(/\s*\|\|\s*/).map(function (range) {
    return this.parseRange(range.trim())
  }, this).filter(function (c) {
    // throw out any that are not relevant for whatever reason
    return c.length
  })

  if (!this.set.length) {
    throw new TypeError('Invalid SemVer Range: ' + range)
  }

  this.format()
}

Range.prototype.format = function () {
  this.range = this.set.map(function (comps) {
    return comps.join(' ').trim()
  }).join('||').trim()
  return this.range
}

Range.prototype.toString = function () {
  return this.range
}

Range.prototype.parseRange = function (range) {
  var loose = this.options.loose
  range = range.trim()
  // `1.2.3 - 1.2.4` => `>=1.2.3 <=1.2.4`
  var hr = loose ? re[t.HYPHENRANGELOOSE] : re[t.HYPHENRANGE]
  range = range.replace(hr, hyphenReplace)
  debug('hyphen replace', range)
  // `> 1.2.3 < 1.2.5` => `>1.2.3 <1.2.5`
  range = range.replace(re[t.COMPARATORTRIM], comparatorTrimReplace)
  debug('comparator trim', range, re[t.COMPARATORTRIM])

  // `~ 1.2.3` => `~1.2.3`
  range = range.replace(re[t.TILDETRIM], tildeTrimReplace)

  // `^ 1.2.3` => `^1.2.3`
  range = range.replace(re[t.CARETTRIM], caretTrimReplace)

  // normalize spaces
  range = range.split(/\s+/).join(' ')

  // At this point, the range is completely trimmed and
  // ready to be split into comparators.

  var compRe = loose ? re[t.COMPARATORLOOSE] : re[t.COMPARATOR]
  var set = range.split(' ').map(function (comp) {
    return parseComparator(comp, this.options)
  }, this).join(' ').split(/\s+/)
  if (this.options.loose) {
    // in loose mode, throw out any that are not valid comparators
    set = set.filter(function (comp) {
      return !!comp.match(compRe)
    })
  }
  set = set.map(function (comp) {
    return new Comparator(comp, this.options)
  }, this)

  return set
}

Range.prototype.intersects = function (range, options) {
  if (!(range instanceof Range)) {
    throw new TypeError('a Range is required')
  }

  return this.set.some(function (thisComparators) {
    return (
      isSatisfiable(thisComparators, options) &&
      range.set.some(function (rangeComparators) {
        return (
          isSatisfiable(rangeComparators, options) &&
          thisComparators.every(function (thisComparator) {
            return rangeComparators.every(function (rangeComparator) {
              return thisComparator.intersects(rangeComparator, options)
            })
          })
        )
      })
    )
  })
}

// take a set of comparators and determine whether there
// exists a version which can satisfy it
function isSatisfiable (comparators, options) {
  var result = true
  var remainingComparators = comparators.slice()
  var testComparator = remainingComparators.pop()

  while (result && remainingComparators.length) {
    result = remainingComparators.every(function (otherComparator) {
      return testComparator.intersects(otherComparator, options)
    })

    testComparator = remainingComparators.pop()
  }

  return result
}

// Mostly just for testing and legacy API reasons
exports.toComparators = toComparators
function toComparators (range, options) {
  return new Range(range, options).set.map(function (comp) {
    return comp.map(function (c) {
      return c.value
    }).join(' ').trim().split(' ')
  })
}

// comprised of xranges, tildes, stars, and gtlt's at this point.
// already replaced the hyphen ranges
// turn into a set of JUST comparators.
function parseComparator (comp, options) {
  debug('comp', comp, options)
  comp = replaceCarets(comp, options)
  debug('caret', comp)
  comp = replaceTildes(comp, options)
  debug('tildes', comp)
  comp = replaceXRanges(comp, options)
  debug('xrange', comp)
  comp = replaceStars(comp, options)
  debug('stars', comp)
  return comp
}

function isX (id) {
  return !id || id.toLowerCase() === 'x' || id === '*'
}

// ~, ~> --> * (any, kinda silly)
// ~2, ~2.x, ~2.x.x, ~>2, ~>2.x ~>2.x.x --> >=2.0.0 <3.0.0
// ~2.0, ~2.0.x, ~>2.0, ~>2.0.x --> >=2.0.0 <2.1.0
// ~1.2, ~1.2.x, ~>1.2, ~>1.2.x --> >=1.2.0 <1.3.0
// ~1.2.3, ~>1.2.3 --> >=1.2.3 <1.3.0
// ~1.2.0, ~>1.2.0 --> >=1.2.0 <1.3.0
function replaceTildes (comp, options) {
  return comp.trim().split(/\s+/).map(function (comp) {
    return replaceTilde(comp, options)
  }).join(' ')
}

function replaceTilde (comp, options) {
  var r = options.loose ? re[t.TILDELOOSE] : re[t.TILDE]
  return comp.replace(r, function (_, M, m, p, pr) {
    debug('tilde', comp, _, M, m, p, pr)
    var ret

    if (isX(M)) {
      ret = ''
    } else if (isX(m)) {
      ret = '>=' + M + '.0.0 <' + (+M + 1) + '.0.0'
    } else if (isX(p)) {
      // ~1.2 == >=1.2.0 <1.3.0
      ret = '>=' + M + '.' + m + '.0 <' + M + '.' + (+m + 1) + '.0'
    } else if (pr) {
      debug('replaceTilde pr', pr)
      ret = '>=' + M + '.' + m + '.' + p + '-' + pr +
            ' <' + M + '.' + (+m + 1) + '.0'
    } else {
      // ~1.2.3 == >=1.2.3 <1.3.0
      ret = '>=' + M + '.' + m + '.' + p +
            ' <' + M + '.' + (+m + 1) + '.0'
    }

    debug('tilde return', ret)
    return ret
  })
}

// ^ --> * (any, kinda silly)
// ^2, ^2.x, ^2.x.x --> >=2.0.0 <3.0.0
// ^2.0, ^2.0.x --> >=2.0.0 <3.0.0
// ^1.2, ^1.2.x --> >=1.2.0 <2.0.0
// ^1.2.3 --> >=1.2.3 <2.0.0
// ^1.2.0 --> >=1.2.0 <2.0.0
function replaceCarets (comp, options) {
  return comp.trim().split(/\s+/).map(function (comp) {
    return replaceCaret(comp, options)
  }).join(' ')
}

function replaceCaret (comp, options) {
  debug('caret', comp, options)
  var r = options.loose ? re[t.CARETLOOSE] : re[t.CARET]
  return comp.replace(r, function (_, M, m, p, pr) {
    debug('caret', comp, _, M, m, p, pr)
    var ret

    if (isX(M)) {
      ret = ''
    } else if (isX(m)) {
      ret = '>=' + M + '.0.0 <' + (+M + 1) + '.0.0'
    } else if (isX(p)) {
      if (M === '0') {
        ret = '>=' + M + '.' + m + '.0 <' + M + '.' + (+m + 1) + '.0'
      } else {
        ret = '>=' + M + '.' + m + '.0 <' + (+M + 1) + '.0.0'
      }
    } else if (pr) {
      debug('replaceCaret pr', pr)
      if (M === '0') {
        if (m === '0') {
          ret = '>=' + M + '.' + m + '.' + p + '-' + pr +
                ' <' + M + '.' + m + '.' + (+p + 1)
        } else {
          ret = '>=' + M + '.' + m + '.' + p + '-' + pr +
                ' <' + M + '.' + (+m + 1) + '.0'
        }
      } else {
        ret = '>=' + M + '.' + m + '.' + p + '-' + pr +
              ' <' + (+M + 1) + '.0.0'
      }
    } else {
      debug('no pr')
      if (M === '0') {
        if (m === '0') {
          ret = '>=' + M + '.' + m + '.' + p +
                ' <' + M + '.' + m + '.' + (+p + 1)
        } else {
          ret = '>=' + M + '.' + m + '.' + p +
                ' <' + M + '.' + (+m + 1) + '.0'
        }
      } else {
        ret = '>=' + M + '.' + m + '.' + p +
              ' <' + (+M + 1) + '.0.0'
      }
    }

    debug('caret return', ret)
    return ret
  })
}

function replaceXRanges (comp, options) {
  debug('replaceXRanges', comp, options)
  return comp.split(/\s+/).map(function (comp) {
    return replaceXRange(comp, options)
  }).join(' ')
}

function replaceXRange (comp, options) {
  comp = comp.trim()
  var r = options.loose ? re[t.XRANGELOOSE] : re[t.XRANGE]
  return comp.replace(r, function (ret, gtlt, M, m, p, pr) {
    debug('xRange', comp, ret, gtlt, M, m, p, pr)
    var xM = isX(M)
    var xm = xM || isX(m)
    var xp = xm || isX(p)
    var anyX = xp

    if (gtlt === '=' && anyX) {
      gtlt = ''
    }

    // if we're including prereleases in the match, then we need
    // to fix this to -0, the lowest possible prerelease value
    pr = options.includePrerelease ? '-0' : ''

    if (xM) {
      if (gtlt === '>' || gtlt === '<') {
        // nothing is allowed
        ret = '<0.0.0-0'
      } else {
        // nothing is forbidden
        ret = '*'
      }
    } else if (gtlt && anyX) {
      // we know patch is an x, because we have any x at all.
      // replace X with 0
      if (xm) {
        m = 0
      }
      p = 0

      if (gtlt === '>') {
        // >1 => >=2.0.0
        // >1.2 => >=1.3.0
        // >1.2.3 => >= 1.2.4
        gtlt = '>='
        if (xm) {
          M = +M + 1
          m = 0
          p = 0
        } else {
          m = +m + 1
          p = 0
        }
      } else if (gtlt === '<=') {
        // <=0.7.x is actually <0.8.0, since any 0.7.x should
        // pass.  Similarly, <=7.x is actually <8.0.0, etc.
        gtlt = '<'
        if (xm) {
          M = +M + 1
        } else {
          m = +m + 1
        }
      }

      ret = gtlt + M + '.' + m + '.' + p + pr
    } else if (xm) {
      ret = '>=' + M + '.0.0' + pr + ' <' + (+M + 1) + '.0.0' + pr
    } else if (xp) {
      ret = '>=' + M + '.' + m + '.0' + pr +
        ' <' + M + '.' + (+m + 1) + '.0' + pr
    }

    debug('xRange return', ret)

    return ret
  })
}

// Because * is AND-ed with everything else in the comparator,
// and '' means "any version", just remove the *s entirely.
function replaceStars (comp, options) {
  debug('replaceStars', comp, options)
  // Looseness is ignored here.  star is always as loose as it gets!
  return comp.trim().replace(re[t.STAR], '')
}

// This function is passed to string.replace(re[t.HYPHENRANGE])
// M, m, patch, prerelease, build
// 1.2 - 3.4.5 => >=1.2.0 <=3.4.5
// 1.2.3 - 3.4 => >=1.2.0 <3.5.0 Any 3.4.x will do
// 1.2 - 3.4 => >=1.2.0 <3.5.0
function hyphenReplace ($0,
  from, fM, fm, fp, fpr, fb,
  to, tM, tm, tp, tpr, tb) {
  if (isX(fM)) {
    from = ''
  } else if (isX(fm)) {
    from = '>=' + fM + '.0.0'
  } else if (isX(fp)) {
    from = '>=' + fM + '.' + fm + '.0'
  } else {
    from = '>=' + from
  }

  if (isX(tM)) {
    to = ''
  } else if (isX(tm)) {
    to = '<' + (+tM + 1) + '.0.0'
  } else if (isX(tp)) {
    to = '<' + tM + '.' + (+tm + 1) + '.0'
  } else if (tpr) {
    to = '<=' + tM + '.' + tm + '.' + tp + '-' + tpr
  } else {
    to = '<=' + to
  }

  return (from + ' ' + to).trim()
}

// if ANY of the sets match ALL of its comparators, then pass
Range.prototype.test = function (version) {
  if (!version) {
    return false
  }

  if (typeof version === 'string') {
    try {
      version = new SemVer(version, this.options)
    } catch (er) {
      return false
    }
  }

  for (var i = 0; i < this.set.length; i++) {
    if (testSet(this.set[i], version, this.options)) {
      return true
    }
  }
  return false
}

function testSet (set, version, options) {
  for (var i = 0; i < set.length; i++) {
    if (!set[i].test(version)) {
      return false
    }
  }

  if (version.prerelease.length && !options.includePrerelease) {
    // Find the set of versions that are allowed to have prereleases
    // For example, ^1.2.3-pr.1 desugars to >=1.2.3-pr.1 <2.0.0
    // That should allow `1.2.3-pr.2` to pass.
    // However, `1.2.4-alpha.notready` should NOT be allowed,
    // even though it's within the range set by the comparators.
    for (i = 0; i < set.length; i++) {
      debug(set[i].semver)
      if (set[i].semver === ANY) {
        continue
      }

      if (set[i].semver.prerelease.length > 0) {
        var allowed = set[i].semver
        if (allowed.major === version.major &&
            allowed.minor === version.minor &&
            allowed.patch === version.patch) {
          return true
        }
      }
    }

    // Version has a -pre, but it's not one of the ones we like.
    return false
  }

  return true
}

exports.satisfies = satisfies
function satisfies (version, range, options) {
  try {
    range = new Range(range, options)
  } catch (er) {
    return false
  }
  return range.test(version)
}

exports.maxSatisfying = maxSatisfying
function maxSatisfying (versions, range, options) {
  var max = null
  var maxSV = null
  try {
    var rangeObj = new Range(range, options)
  } catch (er) {
    return null
  }
  versions.forEach(function (v) {
    if (rangeObj.test(v)) {
      // satisfies(v, range, options)
      if (!max || maxSV.compare(v) === -1) {
        // compare(max, v, true)
        max = v
        maxSV = new SemVer(max, options)
      }
    }
  })
  return max
}

exports.minSatisfying = minSatisfying
function minSatisfying (versions, range, options) {
  var min = null
  var minSV = null
  try {
    var rangeObj = new Range(range, options)
  } catch (er) {
    return null
  }
  versions.forEach(function (v) {
    if (rangeObj.test(v)) {
      // satisfies(v, range, options)
      if (!min || minSV.compare(v) === 1) {
        // compare(min, v, true)
        min = v
        minSV = new SemVer(min, options)
      }
    }
  })
  return min
}

exports.minVersion = minVersion
function minVersion (range, loose) {
  range = new Range(range, loose)

  var minver = new SemVer('0.0.0')
  if (range.test(minver)) {
    return minver
  }

  minver = new SemVer('0.0.0-0')
  if (range.test(minver)) {
    return minver
  }

  minver = null
  for (var i = 0; i < range.set.length; ++i) {
    var comparators = range.set[i]

    comparators.forEach(function (comparator) {
      // Clone to avoid manipulating the comparator's semver object.
      var compver = new SemVer(comparator.semver.version)
      switch (comparator.operator) {
        case '>':
          if (compver.prerelease.length === 0) {
            compver.patch++
          } else {
            compver.prerelease.push(0)
          }
          compver.raw = compver.format()
          /* fallthrough */
        case '':
        case '>=':
          if (!minver || gt(minver, compver)) {
            minver = compver
          }
          break
        case '<':
        case '<=':
          /* Ignore maximum versions */
          break
        /* istanbul ignore next */
        default:
          throw new Error('Unexpected operation: ' + comparator.operator)
      }
    })
  }

  if (minver && range.test(minver)) {
    return minver
  }

  return null
}

exports.validRange = validRange
function validRange (range, options) {
  try {
    // Return '*' instead of '' so that truthiness works.
    // This will throw if it's invalid anyway
    return new Range(range, options).range || '*'
  } catch (er) {
    return null
  }
}

// Determine if version is less than all the versions possible in the range
exports.ltr = ltr
function ltr (version, range, options) {
  return outside(version, range, '<', options)
}

// Determine if version is greater than all the versions possible in the range.
exports.gtr = gtr
function gtr (version, range, options) {
  return outside(version, range, '>', options)
}

exports.outside = outside
function outside (version, range, hilo, options) {
  version = new SemVer(version, options)
  range = new Range(range, options)

  var gtfn, ltefn, ltfn, comp, ecomp
  switch (hilo) {
    case '>':
      gtfn = gt
      ltefn = lte
      ltfn = lt
      comp = '>'
      ecomp = '>='
      break
    case '<':
      gtfn = lt
      ltefn = gte
      ltfn = gt
      comp = '<'
      ecomp = '<='
      break
    default:
      throw new TypeError('Must provide a hilo val of "<" or ">"')
  }

  // If it satisifes the range it is not outside
  if (satisfies(version, range, options)) {
    return false
  }

  // From now on, variable terms are as if we're in "gtr" mode.
  // but note that everything is flipped for the "ltr" function.

  for (var i = 0; i < range.set.length; ++i) {
    var comparators = range.set[i]

    var high = null
    var low = null

    comparators.forEach(function (comparator) {
      if (comparator.semver === ANY) {
        comparator = new Comparator('>=0.0.0')
      }
      high = high || comparator
      low = low || comparator
      if (gtfn(comparator.semver, high.semver, options)) {
        high = comparator
      } else if (ltfn(comparator.semver, low.semver, options)) {
        low = comparator
      }
    })

    // If the edge version comparator has a operator then our version
    // isn't outside it
    if (high.operator === comp || high.operator === ecomp) {
      return false
    }

    // If the lowest version comparator has an operator and our version
    // is less than it then it isn't higher than the range
    if ((!low.operator || low.operator === comp) &&
        ltefn(version, low.semver)) {
      return false
    } else if (low.operator === ecomp && ltfn(version, low.semver)) {
      return false
    }
  }
  return true
}

exports.prerelease = prerelease
function prerelease (version, options) {
  var parsed = parse(version, options)
  return (parsed && parsed.prerelease.length) ? parsed.prerelease : null
}

exports.intersects = intersects
function intersects (r1, r2, options) {
  r1 = new Range(r1, options)
  r2 = new Range(r2, options)
  return r1.intersects(r2)
}

exports.coerce = coerce
function coerce (version, options) {
  if (version instanceof SemVer) {
    return version
  }

  if (typeof version === 'number') {
    version = String(version)
  }

  if (typeof version !== 'string') {
    return null
  }

  options = options || {}

  var match = null
  if (!options.rtl) {
    match = version.match(re[t.COERCE])
  } else {
    // Find the right-most coercible string that does not share
    // a terminus with a more left-ward coercible string.
    // Eg, '1.2.3.4' wants to coerce '2.3.4', not '3.4' or '4'
    //
    // Walk through the string checking with a /g regexp
    // Manually set the index so as to pick up overlapping matches.
    // Stop when we get a match that ends at the string end, since no
    // coercible string can be more right-ward without the same terminus.
    var next
    while ((next = re[t.COERCERTL].exec(version)) &&
      (!match || match.index + match[0].length !== version.length)
    ) {
      if (!match ||
          next.index + next[0].length !== match.index + match[0].length) {
        match = next
      }
      re[t.COERCERTL].lastIndex = next.index + next[1].length + next[2].length
    }
    // leave it in a clean state
    re[t.COERCERTL].lastIndex = -1
  }

  if (match === null) {
    return null
  }

  return parse(match[2] +
    '.' + (match[3] || '0') +
    '.' + (match[4] || '0'), options)
}


/***/ }),

/***/ 4269:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * set-value <https://github.com/jonschlinkert/set-value>
 *
 * Copyright (c) 2014-2015, 2017, Jon Schlinkert.
 * Released under the MIT License.
 */



var split = __nccwpck_require__(4960);
var extend = __nccwpck_require__(7512);
var isPlainObject = __nccwpck_require__(7810);
var isObject = __nccwpck_require__(429);

module.exports = function(obj, prop, val) {
  if (!isObject(obj)) {
    return obj;
  }

  if (Array.isArray(prop)) {
    prop = [].concat.apply([], prop).join('.');
  }

  if (typeof prop !== 'string') {
    return obj;
  }

  var keys = split(prop, {sep: '.', brackets: true}).filter(isValidKey);
  var len = keys.length;
  var idx = -1;
  var current = obj;

  while (++idx < len) {
    var key = keys[idx];
    if (idx !== len - 1) {
      if (!isObject(current[key])) {
        current[key] = {};
      }
      current = current[key];
      continue;
    }

    if (isPlainObject(current[key]) && isPlainObject(val)) {
      current[key] = extend({}, current[key], val);
    } else {
      current[key] = val;
    }
  }

  return obj;
};

function isValidKey(key) {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
}


/***/ }),

/***/ 7543:
/***/ ((module) => {


module.exports = input => {
	const isExtendedLengthPath = /^\\\\\?\\/.test(input);
	const hasNonAscii = /[^\u0000-\u0080]+/.test(input); // eslint-disable-line no-control-regex

	if (isExtendedLengthPath || hasNonAscii) {
		return input;
	}

	return input.replace(/\\/g, '/');
};


/***/ }),

/***/ 5244:
/***/ ((module, exports, __nccwpck_require__) => {



var isObject = __nccwpck_require__(5509);
var define = __nccwpck_require__(5432);
var utils = __nccwpck_require__(2297);
var ownNames;

/**
 * Create a new AST `Node` with the given `val` and `type`.
 *
 * ```js
 * var node = new Node('*', 'Star');
 * var node = new Node({type: 'star', val: '*'});
 * ```
 * @name Node
 * @param {String|Object} `val` Pass a matched substring, or an object to merge onto the node.
 * @param {String} `type` The node type to use when `val` is a string.
 * @return {Object} node instance
 * @api public
 */

function Node(val, type, parent) {
  if (typeof type !== 'string') {
    parent = type;
    type = null;
  }

  define(this, 'parent', parent);
  define(this, 'isNode', true);
  define(this, 'expect', null);

  if (typeof type !== 'string' && isObject(val)) {
    lazyKeys();
    var keys = Object.keys(val);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (ownNames.indexOf(key) === -1) {
        this[key] = val[key];
      }
    }
  } else {
    this.type = type;
    this.val = val;
  }
}

/**
 * Returns true if the given value is a node.
 *
 * ```js
 * var Node = require('snapdragon-node');
 * var node = new Node({type: 'foo'});
 * console.log(Node.isNode(node)); //=> true
 * console.log(Node.isNode({})); //=> false
 * ```
 * @param {Object} `node`
 * @returns {Boolean}
 * @api public
 */

Node.isNode = function(node) {
  return utils.isNode(node);
};

/**
 * Define a non-enumberable property on the node instance.
 * Useful for adding properties that shouldn't be extended
 * or visible during debugging.
 *
 * ```js
 * var node = new Node();
 * node.define('foo', 'something non-enumerable');
 * ```
 * @param {String} `name`
 * @param {any} `val`
 * @return {Object} returns the node instance
 * @api public
 */

Node.prototype.define = function(name, val) {
  define(this, name, val);
  return this;
};

/**
 * Returns true if `node.val` is an empty string, or `node.nodes` does
 * not contain any non-empty text nodes.
 *
 * ```js
 * var node = new Node({type: 'text'});
 * node.isEmpty(); //=> true
 * node.val = 'foo';
 * node.isEmpty(); //=> false
 * ```
 * @param {Function} `fn` (optional) Filter function that is called on `node` and/or child nodes. `isEmpty` will return false immediately when the filter function returns false on any nodes.
 * @return {Boolean}
 * @api public
 */

Node.prototype.isEmpty = function(fn) {
  return utils.isEmpty(this, fn);
};

/**
 * Given node `foo` and node `bar`, push node `bar` onto `foo.nodes`, and
 * set `foo` as `bar.parent`.
 *
 * ```js
 * var foo = new Node({type: 'foo'});
 * var bar = new Node({type: 'bar'});
 * foo.push(bar);
 * ```
 * @param {Object} `node`
 * @return {Number} Returns the length of `node.nodes`
 * @api public
 */

Node.prototype.push = function(node) {
  assert(Node.isNode(node), 'expected node to be an instance of Node');
  define(node, 'parent', this);

  this.nodes = this.nodes || [];
  return this.nodes.push(node);
};

/**
 * Given node `foo` and node `bar`, unshift node `bar` onto `foo.nodes`, and
 * set `foo` as `bar.parent`.
 *
 * ```js
 * var foo = new Node({type: 'foo'});
 * var bar = new Node({type: 'bar'});
 * foo.unshift(bar);
 * ```
 * @param {Object} `node`
 * @return {Number} Returns the length of `node.nodes`
 * @api public
 */

Node.prototype.unshift = function(node) {
  assert(Node.isNode(node), 'expected node to be an instance of Node');
  define(node, 'parent', this);

  this.nodes = this.nodes || [];
  return this.nodes.unshift(node);
};

/**
 * Pop a node from `node.nodes`.
 *
 * ```js
 * var node = new Node({type: 'foo'});
 * node.push(new Node({type: 'a'}));
 * node.push(new Node({type: 'b'}));
 * node.push(new Node({type: 'c'}));
 * node.push(new Node({type: 'd'}));
 * console.log(node.nodes.length);
 * //=> 4
 * node.pop();
 * console.log(node.nodes.length);
 * //=> 3
 * ```
 * @return {Number} Returns the popped `node`
 * @api public
 */

Node.prototype.pop = function() {
  return this.nodes && this.nodes.pop();
};

/**
 * Shift a node from `node.nodes`.
 *
 * ```js
 * var node = new Node({type: 'foo'});
 * node.push(new Node({type: 'a'}));
 * node.push(new Node({type: 'b'}));
 * node.push(new Node({type: 'c'}));
 * node.push(new Node({type: 'd'}));
 * console.log(node.nodes.length);
 * //=> 4
 * node.shift();
 * console.log(node.nodes.length);
 * //=> 3
 * ```
 * @return {Object} Returns the shifted `node`
 * @api public
 */

Node.prototype.shift = function() {
  return this.nodes && this.nodes.shift();
};

/**
 * Remove `node` from `node.nodes`.
 *
 * ```js
 * node.remove(childNode);
 * ```
 * @param {Object} `node`
 * @return {Object} Returns the removed node.
 * @api public
 */

Node.prototype.remove = function(node) {
  assert(Node.isNode(node), 'expected node to be an instance of Node');
  this.nodes = this.nodes || [];
  var idx = node.index;
  if (idx !== -1) {
    node.index = -1;
    return this.nodes.splice(idx, 1);
  }
  return null;
};

/**
 * Get the first child node from `node.nodes` that matches the given `type`.
 * If `type` is a number, the child node at that index is returned.
 *
 * ```js
 * var child = node.find(1); //<= index of the node to get
 * var child = node.find('foo'); //<= node.type of a child node
 * var child = node.find(/^(foo|bar)$/); //<= regex to match node.type
 * var child = node.find(['foo', 'bar']); //<= array of node.type(s)
 * ```
 * @param {String} `type`
 * @return {Object} Returns a child node or undefined.
 * @api public
 */

Node.prototype.find = function(type) {
  return utils.findNode(this.nodes, type);
};

/**
 * Return true if the node is the given `type`.
 *
 * ```js
 * var node = new Node({type: 'bar'});
 * cosole.log(node.isType('foo'));          // false
 * cosole.log(node.isType(/^(foo|bar)$/));  // true
 * cosole.log(node.isType(['foo', 'bar'])); // true
 * ```
 * @param {String} `type`
 * @return {Boolean}
 * @api public
 */

Node.prototype.isType = function(type) {
  return utils.isType(this, type);
};

/**
 * Return true if the `node.nodes` has the given `type`.
 *
 * ```js
 * var foo = new Node({type: 'foo'});
 * var bar = new Node({type: 'bar'});
 * foo.push(bar);
 *
 * cosole.log(foo.hasType('qux'));          // false
 * cosole.log(foo.hasType(/^(qux|bar)$/));  // true
 * cosole.log(foo.hasType(['qux', 'bar'])); // true
 * ```
 * @param {String} `type`
 * @return {Boolean}
 * @api public
 */

Node.prototype.hasType = function(type) {
  return utils.hasType(this, type);
};

/**
 * Get the siblings array, or `null` if it doesn't exist.
 *
 * ```js
 * var foo = new Node({type: 'foo'});
 * var bar = new Node({type: 'bar'});
 * var baz = new Node({type: 'baz'});
 * foo.push(bar);
 * foo.push(baz);
 *
 * console.log(bar.siblings.length) // 2
 * console.log(baz.siblings.length) // 2
 * ```
 * @return {Array}
 * @api public
 */

Object.defineProperty(Node.prototype, 'siblings', {
  set: function() {
    throw new Error('node.siblings is a getter and cannot be defined');
  },
  get: function() {
    return this.parent ? this.parent.nodes : null;
  }
});

/**
 * Get the node's current index from `node.parent.nodes`.
 * This should always be correct, even when the parent adds nodes.
 *
 * ```js
 * var foo = new Node({type: 'foo'});
 * var bar = new Node({type: 'bar'});
 * var baz = new Node({type: 'baz'});
 * var qux = new Node({type: 'qux'});
 * foo.push(bar);
 * foo.push(baz);
 * foo.unshift(qux);
 *
 * console.log(bar.index) // 1
 * console.log(baz.index) // 2
 * console.log(qux.index) // 0
 * ```
 * @return {Number}
 * @api public
 */

Object.defineProperty(Node.prototype, 'index', {
  set: function(index) {
    define(this, 'idx', index);
  },
  get: function() {
    if (!Array.isArray(this.siblings)) {
      return -1;
    }
    var tok = this.idx !== -1 ? this.siblings[this.idx] : null;
    if (tok !== this) {
      this.idx = this.siblings.indexOf(this);
    }
    return this.idx;
  }
});

/**
 * Get the previous node from the siblings array or `null`.
 *
 * ```js
 * var foo = new Node({type: 'foo'});
 * var bar = new Node({type: 'bar'});
 * var baz = new Node({type: 'baz'});
 * foo.push(bar);
 * foo.push(baz);
 *
 * console.log(baz.prev.type) // 'bar'
 * ```
 * @return {Object}
 * @api public
 */

Object.defineProperty(Node.prototype, 'prev', {
  set: function() {
    throw new Error('node.prev is a getter and cannot be defined');
  },
  get: function() {
    if (Array.isArray(this.siblings)) {
      return this.siblings[this.index - 1] || this.parent.prev;
    }
    return null;
  }
});

/**
 * Get the siblings array, or `null` if it doesn't exist.
 *
 * ```js
 * var foo = new Node({type: 'foo'});
 * var bar = new Node({type: 'bar'});
 * var baz = new Node({type: 'baz'});
 * foo.push(bar);
 * foo.push(baz);
 *
 * console.log(bar.siblings.length) // 2
 * console.log(baz.siblings.length) // 2
 * ```
 * @return {Object}
 * @api public
 */

Object.defineProperty(Node.prototype, 'next', {
  set: function() {
    throw new Error('node.next is a getter and cannot be defined');
  },
  get: function() {
    if (Array.isArray(this.siblings)) {
      return this.siblings[this.index + 1] || this.parent.next;
    }
    return null;
  }
});

/**
 * Get the first node from `node.nodes`.
 *
 * ```js
 * var foo = new Node({type: 'foo'});
 * var bar = new Node({type: 'bar'});
 * var baz = new Node({type: 'baz'});
 * var qux = new Node({type: 'qux'});
 * foo.push(bar);
 * foo.push(baz);
 * foo.push(qux);
 *
 * console.log(foo.first.type) // 'bar'
 * ```
 * @return {Object} The first node, or undefiend
 * @api public
 */

Object.defineProperty(Node.prototype, 'first', {
  get: function() {
    return this.nodes ? this.nodes[0] : null;
  }
});

/**
 * Get the last node from `node.nodes`.
 *
 * ```js
 * var foo = new Node({type: 'foo'});
 * var bar = new Node({type: 'bar'});
 * var baz = new Node({type: 'baz'});
 * var qux = new Node({type: 'qux'});
 * foo.push(bar);
 * foo.push(baz);
 * foo.push(qux);
 *
 * console.log(foo.last.type) // 'qux'
 * ```
 * @return {Object} The last node, or undefiend
 * @api public
 */

Object.defineProperty(Node.prototype, 'last', {
  get: function() {
    return this.nodes ? utils.last(this.nodes) : null;
  }
});

/**
 * Get the last node from `node.nodes`.
 *
 * ```js
 * var foo = new Node({type: 'foo'});
 * var bar = new Node({type: 'bar'});
 * var baz = new Node({type: 'baz'});
 * var qux = new Node({type: 'qux'});
 * foo.push(bar);
 * foo.push(baz);
 * foo.push(qux);
 *
 * console.log(foo.last.type) // 'qux'
 * ```
 * @return {Object} The last node, or undefiend
 * @api public
 */

Object.defineProperty(Node.prototype, 'scope', {
  get: function() {
    if (this.isScope !== true) {
      return this.parent ? this.parent.scope : this;
    }
    return this;
  }
});

/**
 * Get own property names from Node prototype, but only the
 * first time `Node` is instantiated
 */

function lazyKeys() {
  if (!ownNames) {
    ownNames = Object.getOwnPropertyNames(Node.prototype);
  }
}

/**
 * Simplified assertion. Throws an error is `val` is falsey.
 */

function assert(val, message) {
  if (!val) throw new Error(message);
}

/**
 * Expose `Node`
 */

exports = module.exports = Node;


/***/ }),

/***/ 5432:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * define-property <https://github.com/jonschlinkert/define-property>
 *
 * Copyright (c) 2015, 2017, Jon Schlinkert.
 * Released under the MIT License.
 */



var isDescriptor = __nccwpck_require__(567);

module.exports = function defineProperty(obj, prop, val) {
  if (typeof obj !== 'object' && typeof obj !== 'function') {
    throw new TypeError('expected an object or function.');
  }

  if (typeof prop !== 'string') {
    throw new TypeError('expected `prop` to be a string.');
  }

  if (isDescriptor(val) && ('set' in val || 'get' in val)) {
    return Object.defineProperty(obj, prop, val);
  }

  return Object.defineProperty(obj, prop, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: val
  });
};


/***/ }),

/***/ 2297:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var typeOf = __nccwpck_require__(6961);
var utils = module.exports;

/**
 * Returns true if the given value is a node.
 *
 * ```js
 * var Node = require('snapdragon-node');
 * var node = new Node({type: 'foo'});
 * console.log(utils.isNode(node)); //=> true
 * console.log(utils.isNode({})); //=> false
 * ```
 * @param {Object} `node` Instance of [snapdragon-node][]
 * @returns {Boolean}
 * @api public
 */

utils.isNode = function(node) {
  return typeOf(node) === 'object' && node.isNode === true;
};

/**
 * Emit an empty string for the given `node`.
 *
 * ```js
 * // do nothing for beginning-of-string
 * snapdragon.compiler.set('bos', utils.noop);
 * ```
 * @param {Object} `node` Instance of [snapdragon-node][]
 * @returns {undefined}
 * @api public
 */

utils.noop = function(node) {
  append(this, '', node);
};

/**
 * Appdend `node.val` to `compiler.output`, exactly as it was created
 * by the parser.
 *
 * ```js
 * snapdragon.compiler.set('text', utils.identity);
 * ```
 * @param {Object} `node` Instance of [snapdragon-node][]
 * @returns {undefined}
 * @api public
 */

utils.identity = function(node) {
  append(this, node.val, node);
};

/**
 * Previously named `.emit`, this method appends the given `val`
 * to `compiler.output` for the given node. Useful when you know
 * what value should be appended advance, regardless of the actual
 * value of `node.val`.
 *
 * ```js
 * snapdragon.compiler
 *   .set('i', function(node) {
 *     this.mapVisit(node);
 *   })
 *   .set('i.open', utils.append('<i>'))
 *   .set('i.close', utils.append('</i>'))
 * ```
 * @param {Object} `node` Instance of [snapdragon-node][]
 * @returns {Function} Returns a compiler middleware function.
 * @api public
 */

utils.append = function(val) {
  return function(node) {
    append(this, val, node);
  };
};

/**
 * Used in compiler middleware, this onverts an AST node into
 * an empty `text` node and deletes `node.nodes` if it exists.
 * The advantage of this method is that, as opposed to completely
 * removing the node, indices will not need to be re-calculated
 * in sibling nodes, and nothing is appended to the output.
 *
 * ```js
 * utils.toNoop(node);
 * // convert `node.nodes` to the given value instead of deleting it
 * utils.toNoop(node, []);
 * ```
 * @param {Object} `node` Instance of [snapdragon-node][]
 * @param {Array} `nodes` Optionally pass a new `nodes` value, to replace the existing `node.nodes` array.
 * @api public
 */

utils.toNoop = function(node, nodes) {
  if (nodes) {
    node.nodes = nodes;
  } else {
    delete node.nodes;
    node.type = 'text';
    node.val = '';
  }
};

/**
 * Visit `node` with the given `fn`. The built-in `.visit` method in snapdragon
 * automatically calls registered compilers, this allows you to pass a visitor
 * function.
 *
 * ```js
 * snapdragon.compiler.set('i', function(node) {
 *   utils.visit(node, function(childNode) {
 *     // do stuff with "childNode"
 *     return childNode;
 *   });
 * });
 * ```
 * @param {Object} `node` Instance of [snapdragon-node][]
 * @param {Function} `fn`
 * @return {Object} returns the node after recursively visiting all child nodes.
 * @api public
 */

utils.visit = function(node, fn) {
  assert(utils.isNode(node), 'expected node to be an instance of Node');
  assert(isFunction(fn), 'expected a visitor function');
  fn(node);
  return node.nodes ? utils.mapVisit(node, fn) : node;
};

/**
 * Map [visit](#visit) the given `fn` over `node.nodes`. This is called by
 * [visit](#visit), use this method if you do not want `fn` to be called on
 * the first node.
 *
 * ```js
 * snapdragon.compiler.set('i', function(node) {
 *   utils.mapVisit(node, function(childNode) {
 *     // do stuff with "childNode"
 *     return childNode;
 *   });
 * });
 * ```
 * @param {Object} `node` Instance of [snapdragon-node][]
 * @param {Object} `options`
 * @param {Function} `fn`
 * @return {Object} returns the node
 * @api public
 */

utils.mapVisit = function(node, fn) {
  assert(utils.isNode(node), 'expected node to be an instance of Node');
  assert(isArray(node.nodes), 'expected node.nodes to be an array');
  assert(isFunction(fn), 'expected a visitor function');

  for (var i = 0; i < node.nodes.length; i++) {
    utils.visit(node.nodes[i], fn);
  }
  return node;
};

/**
 * Unshift an `*.open` node onto `node.nodes`.
 *
 * ```js
 * var Node = require('snapdragon-node');
 * snapdragon.parser.set('brace', function(node) {
 *   var match = this.match(/^{/);
 *   if (match) {
 *     var parent = new Node({type: 'brace'});
 *     utils.addOpen(parent, Node);
 *     console.log(parent.nodes[0]):
 *     // { type: 'brace.open', val: '' };
 *
 *     // push the parent "brace" node onto the stack
 *     this.push(parent);
 *
 *     // return the parent node, so it's also added to the AST
 *     return brace;
 *   }
 * });
 * ```
 * @param {Object} `node` Instance of [snapdragon-node][]
 * @param {Function} `Node` (required) Node constructor function from [snapdragon-node][].
 * @param {Function} `filter` Optionaly specify a filter function to exclude the node.
 * @return {Object} Returns the created opening node.
 * @api public
 */

utils.addOpen = function(node, Node, val, filter) {
  assert(utils.isNode(node), 'expected node to be an instance of Node');
  assert(isFunction(Node), 'expected Node to be a constructor function');

  if (typeof val === 'function') {
    filter = val;
    val = '';
  }

  if (typeof filter === 'function' && !filter(node)) return;
  var open = new Node({ type: node.type + '.open', val: val});
  var unshift = node.unshift || node.unshiftNode;
  if (typeof unshift === 'function') {
    unshift.call(node, open);
  } else {
    utils.unshiftNode(node, open);
  }
  return open;
};

/**
 * Push a `*.close` node onto `node.nodes`.
 *
 * ```js
 * var Node = require('snapdragon-node');
 * snapdragon.parser.set('brace', function(node) {
 *   var match = this.match(/^}/);
 *   if (match) {
 *     var parent = this.parent();
 *     if (parent.type !== 'brace') {
 *       throw new Error('missing opening: ' + '}');
 *     }
 *
 *     utils.addClose(parent, Node);
 *     console.log(parent.nodes[parent.nodes.length - 1]):
 *     // { type: 'brace.close', val: '' };
 *
 *     // no need to return a node, since the parent
 *     // was already added to the AST
 *     return;
 *   }
 * });
 * ```
 * @param {Object} `node` Instance of [snapdragon-node][]
 * @param {Function} `Node` (required) Node constructor function from [snapdragon-node][].
 * @param {Function} `filter` Optionaly specify a filter function to exclude the node.
 * @return {Object} Returns the created closing node.
 * @api public
 */

utils.addClose = function(node, Node, val, filter) {
  assert(utils.isNode(node), 'expected node to be an instance of Node');
  assert(isFunction(Node), 'expected Node to be a constructor function');

  if (typeof val === 'function') {
    filter = val;
    val = '';
  }

  if (typeof filter === 'function' && !filter(node)) return;
  var close = new Node({ type: node.type + '.close', val: val});
  var push = node.push || node.pushNode;
  if (typeof push === 'function') {
    push.call(node, close);
  } else {
    utils.pushNode(node, close);
  }
  return close;
};

/**
 * Wraps the given `node` with `*.open` and `*.close` nodes.
 *
 * @param {Object} `node` Instance of [snapdragon-node][]
 * @param {Function} `Node` (required) Node constructor function from [snapdragon-node][].
 * @param {Function} `filter` Optionaly specify a filter function to exclude the node.
 * @return {Object} Returns the node
 * @api public
 */

utils.wrapNodes = function(node, Node, filter) {
  assert(utils.isNode(node), 'expected node to be an instance of Node');
  assert(isFunction(Node), 'expected Node to be a constructor function');

  utils.addOpen(node, Node, filter);
  utils.addClose(node, Node, filter);
  return node;
};

/**
 * Push the given `node` onto `parent.nodes`, and set `parent` as `node.parent.
 *
 * ```js
 * var parent = new Node({type: 'foo'});
 * var node = new Node({type: 'bar'});
 * utils.pushNode(parent, node);
 * console.log(parent.nodes[0].type) // 'bar'
 * console.log(node.parent.type) // 'foo'
 * ```
 * @param {Object} `parent`
 * @param {Object} `node` Instance of [snapdragon-node][]
 * @return {Object} Returns the child node
 * @api public
 */

utils.pushNode = function(parent, node) {
  assert(utils.isNode(parent), 'expected parent node to be an instance of Node');
  assert(utils.isNode(node), 'expected node to be an instance of Node');

  node.define('parent', parent);
  parent.nodes = parent.nodes || [];
  parent.nodes.push(node);
  return node;
};

/**
 * Unshift `node` onto `parent.nodes`, and set `parent` as `node.parent.
 *
 * ```js
 * var parent = new Node({type: 'foo'});
 * var node = new Node({type: 'bar'});
 * utils.unshiftNode(parent, node);
 * console.log(parent.nodes[0].type) // 'bar'
 * console.log(node.parent.type) // 'foo'
 * ```
 * @param {Object} `parent`
 * @param {Object} `node` Instance of [snapdragon-node][]
 * @return {undefined}
 * @api public
 */

utils.unshiftNode = function(parent, node) {
  assert(utils.isNode(parent), 'expected parent node to be an instance of Node');
  assert(utils.isNode(node), 'expected node to be an instance of Node');

  node.define('parent', parent);
  parent.nodes = parent.nodes || [];
  parent.nodes.unshift(node);
};

/**
 * Pop the last `node` off of `parent.nodes`. The advantage of
 * using this method is that it checks for `node.nodes` and works
 * with any version of `snapdragon-node`.
 *
 * ```js
 * var parent = new Node({type: 'foo'});
 * utils.pushNode(parent, new Node({type: 'foo'}));
 * utils.pushNode(parent, new Node({type: 'bar'}));
 * utils.pushNode(parent, new Node({type: 'baz'}));
 * console.log(parent.nodes.length); //=> 3
 * utils.popNode(parent);
 * console.log(parent.nodes.length); //=> 2
 * ```
 * @param {Object} `parent`
 * @param {Object} `node` Instance of [snapdragon-node][]
 * @return {Number|Undefined} Returns the length of `node.nodes` or undefined.
 * @api public
 */

utils.popNode = function(node) {
  assert(utils.isNode(node), 'expected node to be an instance of Node');
  if (typeof node.pop === 'function') {
    return node.pop();
  }
  return node.nodes && node.nodes.pop();
};

/**
 * Shift the first `node` off of `parent.nodes`. The advantage of
 * using this method is that it checks for `node.nodes` and works
 * with any version of `snapdragon-node`.
 *
 * ```js
 * var parent = new Node({type: 'foo'});
 * utils.pushNode(parent, new Node({type: 'foo'}));
 * utils.pushNode(parent, new Node({type: 'bar'}));
 * utils.pushNode(parent, new Node({type: 'baz'}));
 * console.log(parent.nodes.length); //=> 3
 * utils.shiftNode(parent);
 * console.log(parent.nodes.length); //=> 2
 * ```
 * @param {Object} `parent`
 * @param {Object} `node` Instance of [snapdragon-node][]
 * @return {Number|Undefined} Returns the length of `node.nodes` or undefined.
 * @api public
 */

utils.shiftNode = function(node) {
  assert(utils.isNode(node), 'expected node to be an instance of Node');
  if (typeof node.shift === 'function') {
    return node.shift();
  }
  return node.nodes && node.nodes.shift();
};

/**
 * Remove the specified `node` from `parent.nodes`.
 *
 * ```js
 * var parent = new Node({type: 'abc'});
 * var foo = new Node({type: 'foo'});
 * utils.pushNode(parent, foo);
 * utils.pushNode(parent, new Node({type: 'bar'}));
 * utils.pushNode(parent, new Node({type: 'baz'}));
 * console.log(parent.nodes.length); //=> 3
 * utils.removeNode(parent, foo);
 * console.log(parent.nodes.length); //=> 2
 * ```
 * @param {Object} `parent`
 * @param {Object} `node` Instance of [snapdragon-node][]
 * @return {Object|undefined} Returns the removed node, if successful, or undefined if it does not exist on `parent.nodes`.
 * @api public
 */

utils.removeNode = function(parent, node) {
  assert(utils.isNode(parent), 'expected parent.node to be an instance of Node');
  assert(utils.isNode(node), 'expected node to be an instance of Node');

  if (!parent.nodes) {
    return null;
  }

  if (typeof parent.remove === 'function') {
    return parent.remove(node);
  }

  var idx = parent.nodes.indexOf(node);
  if (idx !== -1) {
    return parent.nodes.splice(idx, 1);
  }
};

/**
 * Returns true if `node.type` matches the given `type`. Throws a
 * `TypeError` if `node` is not an instance of `Node`.
 *
 * ```js
 * var Node = require('snapdragon-node');
 * var node = new Node({type: 'foo'});
 * console.log(utils.isType(node, 'foo')); // false
 * console.log(utils.isType(node, 'bar')); // true
 * ```
 * @param {Object} `node` Instance of [snapdragon-node][]
 * @param {String} `type`
 * @return {Boolean}
 * @api public
 */

utils.isType = function(node, type) {
  assert(utils.isNode(node), 'expected node to be an instance of Node');
  switch (typeOf(type)) {
    case 'array':
      var types = type.slice();
      for (var i = 0; i < types.length; i++) {
        if (utils.isType(node, types[i])) {
          return true;
        }
      }
      return false;
    case 'string':
      return node.type === type;
    case 'regexp':
      return type.test(node.type);
    default: {
      throw new TypeError('expected "type" to be an array, string or regexp');
    }
  }
};

/**
 * Returns true if the given `node` has the given `type` in `node.nodes`.
 * Throws a `TypeError` if `node` is not an instance of `Node`.
 *
 * ```js
 * var Node = require('snapdragon-node');
 * var node = new Node({
 *   type: 'foo',
 *   nodes: [
 *     new Node({type: 'bar'}),
 *     new Node({type: 'baz'})
 *   ]
 * });
 * console.log(utils.hasType(node, 'xyz')); // false
 * console.log(utils.hasType(node, 'baz')); // true
 * ```
 * @param {Object} `node` Instance of [snapdragon-node][]
 * @param {String} `type`
 * @return {Boolean}
 * @api public
 */

utils.hasType = function(node, type) {
  assert(utils.isNode(node), 'expected node to be an instance of Node');
  if (!Array.isArray(node.nodes)) return false;
  for (var i = 0; i < node.nodes.length; i++) {
    if (utils.isType(node.nodes[i], type)) {
      return true;
    }
  }
  return false;
};

/**
 * Returns the first node from `node.nodes` of the given `type`
 *
 * ```js
 * var node = new Node({
 *   type: 'foo',
 *   nodes: [
 *     new Node({type: 'text', val: 'abc'}),
 *     new Node({type: 'text', val: 'xyz'})
 *   ]
 * });
 *
 * var textNode = utils.firstOfType(node.nodes, 'text');
 * console.log(textNode.val);
 * //=> 'abc'
 * ```
 * @param {Array} `nodes`
 * @param {String} `type`
 * @return {Object|undefined} Returns the first matching node or undefined.
 * @api public
 */

utils.firstOfType = function(nodes, type) {
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    if (utils.isType(node, type)) {
      return node;
    }
  }
};

/**
 * Returns the node at the specified index, or the first node of the
 * given `type` from `node.nodes`.
 *
 * ```js
 * var node = new Node({
 *   type: 'foo',
 *   nodes: [
 *     new Node({type: 'text', val: 'abc'}),
 *     new Node({type: 'text', val: 'xyz'})
 *   ]
 * });
 *
 * var nodeOne = utils.findNode(node.nodes, 'text');
 * console.log(nodeOne.val);
 * //=> 'abc'
 *
 * var nodeTwo = utils.findNode(node.nodes, 1);
 * console.log(nodeTwo.val);
 * //=> 'xyz'
 * ```
 *
 * @param {Array} `nodes`
 * @param {String|Number} `type` Node type or index.
 * @return {Object} Returns a node or undefined.
 * @api public
 */

utils.findNode = function(nodes, type) {
  if (!Array.isArray(nodes)) {
    return null;
  }
  if (typeof type === 'number') {
    return nodes[type];
  }
  return utils.firstOfType(nodes, type);
};

/**
 * Returns true if the given node is an "*.open" node.
 *
 * ```js
 * var Node = require('snapdragon-node');
 * var brace = new Node({type: 'brace'});
 * var open = new Node({type: 'brace.open'});
 * var close = new Node({type: 'brace.close'});
 *
 * console.log(utils.isOpen(brace)); // false
 * console.log(utils.isOpen(open)); // true
 * console.log(utils.isOpen(close)); // false
 * ```
 * @param {Object} `node` Instance of [snapdragon-node][]
 * @return {Boolean}
 * @api public
 */

utils.isOpen = function(node) {
  assert(utils.isNode(node), 'expected node to be an instance of Node');
  return node.type.slice(-5) === '.open';
};

/**
 * Returns true if the given node is a "*.close" node.
 *
 * ```js
 * var Node = require('snapdragon-node');
 * var brace = new Node({type: 'brace'});
 * var open = new Node({type: 'brace.open'});
 * var close = new Node({type: 'brace.close'});
 *
 * console.log(utils.isClose(brace)); // false
 * console.log(utils.isClose(open)); // false
 * console.log(utils.isClose(close)); // true
 * ```
 * @param {Object} `node` Instance of [snapdragon-node][]
 * @return {Boolean}
 * @api public
 */

utils.isClose = function(node) {
  assert(utils.isNode(node), 'expected node to be an instance of Node');
  return node.type.slice(-6) === '.close';
};

/**
 * Returns true if `node.nodes` **has** an `.open` node
 *
 * ```js
 * var Node = require('snapdragon-node');
 * var brace = new Node({
 *   type: 'brace',
 *   nodes: []
 * });
 *
 * var open = new Node({type: 'brace.open'});
 * console.log(utils.hasOpen(brace)); // false
 *
 * brace.pushNode(open);
 * console.log(utils.hasOpen(brace)); // true
 * ```
 * @param {Object} `node` Instance of [snapdragon-node][]
 * @return {Boolean}
 * @api public
 */

utils.hasOpen = function(node) {
  assert(utils.isNode(node), 'expected node to be an instance of Node');
  var first = node.first || node.nodes ? node.nodes[0] : null;
  if (utils.isNode(first)) {
    return first.type === node.type + '.open';
  }
  return false;
};

/**
 * Returns true if `node.nodes` **has** a `.close` node
 *
 * ```js
 * var Node = require('snapdragon-node');
 * var brace = new Node({
 *   type: 'brace',
 *   nodes: []
 * });
 *
 * var close = new Node({type: 'brace.close'});
 * console.log(utils.hasClose(brace)); // false
 *
 * brace.pushNode(close);
 * console.log(utils.hasClose(brace)); // true
 * ```
 * @param {Object} `node` Instance of [snapdragon-node][]
 * @return {Boolean}
 * @api public
 */

utils.hasClose = function(node) {
  assert(utils.isNode(node), 'expected node to be an instance of Node');
  var last = node.last || node.nodes ? node.nodes[node.nodes.length - 1] : null;
  if (utils.isNode(last)) {
    return last.type === node.type + '.close';
  }
  return false;
};

/**
 * Returns true if `node.nodes` has both `.open` and `.close` nodes
 *
 * ```js
 * var Node = require('snapdragon-node');
 * var brace = new Node({
 *   type: 'brace',
 *   nodes: []
 * });
 *
 * var open = new Node({type: 'brace.open'});
 * var close = new Node({type: 'brace.close'});
 * console.log(utils.hasOpen(brace)); // false
 * console.log(utils.hasClose(brace)); // false
 *
 * brace.pushNode(open);
 * brace.pushNode(close);
 * console.log(utils.hasOpen(brace)); // true
 * console.log(utils.hasClose(brace)); // true
 * ```
 * @param {Object} `node` Instance of [snapdragon-node][]
 * @return {Boolean}
 * @api public
 */

utils.hasOpenAndClose = function(node) {
  return utils.hasOpen(node) && utils.hasClose(node);
};

/**
 * Push the given `node` onto the `state.inside` array for the
 * given type. This array is used as a specialized "stack" for
 * only the given `node.type`.
 *
 * ```js
 * var state = { inside: {}};
 * var node = new Node({type: 'brace'});
 * utils.addType(state, node);
 * console.log(state.inside);
 * //=> { brace: [{type: 'brace'}] }
 * ```
 * @param {Object} `state` The `compiler.state` object or custom state object.
 * @param {Object} `node` Instance of [snapdragon-node][]
 * @return {Array} Returns the `state.inside` stack for the given type.
 * @api public
 */

utils.addType = function(state, node) {
  assert(utils.isNode(node), 'expected node to be an instance of Node');
  assert(isObject(state), 'expected state to be an object');

  var type = node.parent
    ? node.parent.type
    : node.type.replace(/\.open$/, '');

  if (!state.hasOwnProperty('inside')) {
    state.inside = {};
  }
  if (!state.inside.hasOwnProperty(type)) {
    state.inside[type] = [];
  }

  var arr = state.inside[type];
  arr.push(node);
  return arr;
};

/**
 * Remove the given `node` from the `state.inside` array for the
 * given type. This array is used as a specialized "stack" for
 * only the given `node.type`.
 *
 * ```js
 * var state = { inside: {}};
 * var node = new Node({type: 'brace'});
 * utils.addType(state, node);
 * console.log(state.inside);
 * //=> { brace: [{type: 'brace'}] }
 * utils.removeType(state, node);
 * //=> { brace: [] }
 * ```
 * @param {Object} `state` The `compiler.state` object or custom state object.
 * @param {Object} `node` Instance of [snapdragon-node][]
 * @return {Array} Returns the `state.inside` stack for the given type.
 * @api public
 */

utils.removeType = function(state, node) {
  assert(utils.isNode(node), 'expected node to be an instance of Node');
  assert(isObject(state), 'expected state to be an object');

  var type = node.parent
    ? node.parent.type
    : node.type.replace(/\.close$/, '');

  if (state.inside.hasOwnProperty(type)) {
    return state.inside[type].pop();
  }
};

/**
 * Returns true if `node.val` is an empty string, or `node.nodes` does
 * not contain any non-empty text nodes.
 *
 * ```js
 * var node = new Node({type: 'text'});
 * utils.isEmpty(node); //=> true
 * node.val = 'foo';
 * utils.isEmpty(node); //=> false
 * ```
 * @param {Object} `node` Instance of [snapdragon-node][]
 * @param {Function} `fn`
 * @return {Boolean}
 * @api public
 */

utils.isEmpty = function(node, fn) {
  assert(utils.isNode(node), 'expected node to be an instance of Node');

  if (!Array.isArray(node.nodes)) {
    if (node.type !== 'text') {
      return true;
    }
    if (typeof fn === 'function') {
      return fn(node, node.parent);
    }
    return !utils.trim(node.val);
  }

  for (var i = 0; i < node.nodes.length; i++) {
    var child = node.nodes[i];
    if (utils.isOpen(child) || utils.isClose(child)) {
      continue;
    }
    if (!utils.isEmpty(child, fn)) {
      return false;
    }
  }

  return true;
};

/**
 * Returns true if the `state.inside` stack for the given type exists
 * and has one or more nodes on it.
 *
 * ```js
 * var state = { inside: {}};
 * var node = new Node({type: 'brace'});
 * console.log(utils.isInsideType(state, 'brace')); //=> false
 * utils.addType(state, node);
 * console.log(utils.isInsideType(state, 'brace')); //=> true
 * utils.removeType(state, node);
 * console.log(utils.isInsideType(state, 'brace')); //=> false
 * ```
 * @param {Object} `state`
 * @param {String} `type`
 * @return {Boolean}
 * @api public
 */

utils.isInsideType = function(state, type) {
  assert(isObject(state), 'expected state to be an object');
  assert(isString(type), 'expected type to be a string');

  if (!state.hasOwnProperty('inside')) {
    return false;
  }

  if (!state.inside.hasOwnProperty(type)) {
    return false;
  }

  return state.inside[type].length > 0;
};

/**
 * Returns true if `node` is either a child or grand-child of the given `type`,
 * or `state.inside[type]` is a non-empty array.
 *
 * ```js
 * var state = { inside: {}};
 * var node = new Node({type: 'brace'});
 * var open = new Node({type: 'brace.open'});
 * console.log(utils.isInside(state, open, 'brace')); //=> false
 * utils.pushNode(node, open);
 * console.log(utils.isInside(state, open, 'brace')); //=> true
 * ```
 * @param {Object} `state` Either the `compiler.state` object, if it exists, or a user-supplied state object.
 * @param {Object} `node` Instance of [snapdragon-node][]
 * @param {String} `type` The `node.type` to check for.
 * @return {Boolean}
 * @api public
 */

utils.isInside = function(state, node, type) {
  assert(utils.isNode(node), 'expected node to be an instance of Node');
  assert(isObject(state), 'expected state to be an object');

  if (Array.isArray(type)) {
    for (var i = 0; i < type.length; i++) {
      if (utils.isInside(state, node, type[i])) {
        return true;
      }
    }
    return false;
  }

  var parent = node.parent;
  if (typeof type === 'string') {
    return (parent && parent.type === type) || utils.isInsideType(state, type);
  }

  if (typeOf(type) === 'regexp') {
    if (parent && parent.type && type.test(parent.type)) {
      return true;
    }

    var keys = Object.keys(state.inside);
    var len = keys.length;
    var idx = -1;
    while (++idx < len) {
      var key = keys[idx];
      var val = state.inside[key];

      if (Array.isArray(val) && val.length !== 0 && type.test(key)) {
        return true;
      }
    }
  }
  return false;
};

/**
 * Get the last `n` element from the given `array`. Used for getting
 * a node from `node.nodes.`
 *
 * @param {Array} `array`
 * @param {Number} `n`
 * @return {undefined}
 * @api public
 */

utils.last = function(arr, n) {
  return arr[arr.length - (n || 1)];
};

/**
 * Cast the given `val` to an array.
 *
 * ```js
 * console.log(utils.arrayify(''));
 * //=> []
 * console.log(utils.arrayify('foo'));
 * //=> ['foo']
 * console.log(utils.arrayify(['foo']));
 * //=> ['foo']
 * ```
 * @param {any} `val`
 * @return {Array}
 * @api public
 */

utils.arrayify = function(val) {
  if (typeof val === 'string' && val !== '') {
    return [val];
  }
  if (!Array.isArray(val)) {
    return [];
  }
  return val;
};

/**
 * Convert the given `val` to a string by joining with `,`. Useful
 * for creating a cheerio/CSS/DOM-style selector from a list of strings.
 *
 * @param {any} `val`
 * @return {Array}
 * @api public
 */

utils.stringify = function(val) {
  return utils.arrayify(val).join(',');
};

/**
 * Ensure that the given value is a string and call `.trim()` on it,
 * or return an empty string.
 *
 * @param {String} `str`
 * @return {String}
 * @api public
 */

utils.trim = function(str) {
  return typeof str === 'string' ? str.trim() : '';
};

/**
 * Return true if val is an object
 */

function isObject(val) {
  return typeOf(val) === 'object';
}

/**
 * Return true if val is a string
 */

function isString(val) {
  return typeof val === 'string';
}

/**
 * Return true if val is a function
 */

function isFunction(val) {
  return typeof val === 'function';
}

/**
 * Return true if val is an array
 */

function isArray(val) {
  return Array.isArray(val);
}

/**
 * Shim to ensure the `.append` methods work with any version of snapdragon
 */

function append(compiler, val, node) {
  if (typeof compiler.append !== 'function') {
    return compiler.emit(val, node);
  }
  return compiler.append(val, node);
}

/**
 * Simplified assertion. Throws an error is `val` is falsey.
 */

function assert(val, message) {
  if (!val) throw new Error(message);
}


/***/ }),

/***/ 2403:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var Base = __nccwpck_require__(842);
var define = __nccwpck_require__(6967);
var Compiler = __nccwpck_require__(9424);
var Parser = __nccwpck_require__(182);
var utils = __nccwpck_require__(3620);
var regexCache = {};
var cache = {};

/**
 * Create a new instance of `Snapdragon` with the given `options`.
 *
 * ```js
 * var snapdragon = new Snapdragon();
 * ```
 *
 * @param {Object} `options`
 * @api public
 */

function Snapdragon(options) {
  Base.call(this, null, options);
  this.options = utils.extend({source: 'string'}, this.options);
  this.compiler = new Compiler(this.options);
  this.parser = new Parser(this.options);

  Object.defineProperty(this, 'compilers', {
    get: function() {
      return this.compiler.compilers;
    }
  });

  Object.defineProperty(this, 'parsers', {
    get: function() {
      return this.parser.parsers;
    }
  });

  Object.defineProperty(this, 'regex', {
    get: function() {
      return this.parser.regex;
    }
  });
}

/**
 * Inherit Base
 */

Base.extend(Snapdragon);

/**
 * Add a parser to `snapdragon.parsers` for capturing the given `type` using
 * the specified regex or parser function. A function is useful if you need
 * to customize how the token is created and/or have access to the parser
 * instance to check options, etc.
 *
 * ```js
 * snapdragon
 *   .capture('slash', /^\//)
 *   .capture('dot', function() {
 *     var pos = this.position();
 *     var m = this.match(/^\./);
 *     if (!m) return;
 *     return pos({
 *       type: 'dot',
 *       val: m[0]
 *     });
 *   });
 * ```
 * @param {String} `type`
 * @param {RegExp|Function} `regex`
 * @return {Object} Returns the parser instance for chaining
 * @api public
 */

Snapdragon.prototype.capture = function() {
  return this.parser.capture.apply(this.parser, arguments);
};

/**
 * Register a plugin `fn`.
 *
 * ```js
 * var snapdragon = new Snapdgragon([options]);
 * snapdragon.use(function() {
 *   console.log(this);          //<= snapdragon instance
 *   console.log(this.parser);   //<= parser instance
 *   console.log(this.compiler); //<= compiler instance
 * });
 * ```
 * @param {Object} `fn`
 * @api public
 */

Snapdragon.prototype.use = function(fn) {
  fn.call(this, this);
  return this;
};

/**
 * Parse the given `str`.
 *
 * ```js
 * var snapdragon = new Snapdgragon([options]);
 * // register parsers
 * snapdragon.parser.use(function() {});
 *
 * // parse
 * var ast = snapdragon.parse('foo/bar');
 * console.log(ast);
 * ```
 * @param {String} `str`
 * @param {Object} `options` Set `options.sourcemap` to true to enable source maps.
 * @return {Object} Returns an AST.
 * @api public
 */

Snapdragon.prototype.parse = function(str, options) {
  this.options = utils.extend({}, this.options, options);
  var parsed = this.parser.parse(str, this.options);

  // add non-enumerable parser reference
  define(parsed, 'parser', this.parser);
  return parsed;
};

/**
 * Compile the given `AST`.
 *
 * ```js
 * var snapdragon = new Snapdgragon([options]);
 * // register plugins
 * snapdragon.use(function() {});
 * // register parser plugins
 * snapdragon.parser.use(function() {});
 * // register compiler plugins
 * snapdragon.compiler.use(function() {});
 *
 * // parse
 * var ast = snapdragon.parse('foo/bar');
 *
 * // compile
 * var res = snapdragon.compile(ast);
 * console.log(res.output);
 * ```
 * @param {Object} `ast`
 * @param {Object} `options`
 * @return {Object} Returns an object with an `output` property with the rendered string.
 * @api public
 */

Snapdragon.prototype.compile = function(ast, options) {
  this.options = utils.extend({}, this.options, options);
  var compiled = this.compiler.compile(ast, this.options);

  // add non-enumerable compiler reference
  define(compiled, 'compiler', this.compiler);
  return compiled;
};

/**
 * Expose `Snapdragon`
 */

module.exports = Snapdragon;

/**
 * Expose `Parser` and `Compiler`
 */

module.exports.Compiler = Compiler;
module.exports.Parser = Parser;


/***/ }),

/***/ 9424:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var use = __nccwpck_require__(9656);
var define = __nccwpck_require__(6967);
var debug = __nccwpck_require__(8237)('snapdragon:compiler');
var utils = __nccwpck_require__(3620);

/**
 * Create a new `Compiler` with the given `options`.
 * @param {Object} `options`
 */

function Compiler(options, state) {
  debug('initializing', __filename);
  this.options = utils.extend({source: 'string'}, options);
  this.state = state || {};
  this.compilers = {};
  this.output = '';
  this.set('eos', function(node) {
    return this.emit(node.val, node);
  });
  this.set('noop', function(node) {
    return this.emit(node.val, node);
  });
  this.set('bos', function(node) {
    return this.emit(node.val, node);
  });
  use(this);
}

/**
 * Prototype methods
 */

Compiler.prototype = {

  /**
   * Throw an error message with details including the cursor position.
   * @param {String} `msg` Message to use in the Error.
   */

  error: function(msg, node) {
    var pos = node.position || {start: {column: 0}};
    var message = this.options.source + ' column:' + pos.start.column + ': ' + msg;

    var err = new Error(message);
    err.reason = msg;
    err.column = pos.start.column;
    err.source = this.pattern;

    if (this.options.silent) {
      this.errors.push(err);
    } else {
      throw err;
    }
  },

  /**
   * Define a non-enumberable property on the `Compiler` instance.
   *
   * ```js
   * compiler.define('foo', 'bar');
   * ```
   * @name .define
   * @param {String} `key` propery name
   * @param {any} `val` property value
   * @return {Object} Returns the Compiler instance for chaining.
   * @api public
   */

  define: function(key, val) {
    define(this, key, val);
    return this;
  },

  /**
   * Emit `node.val`
   */

  emit: function(str, node) {
    this.output += str;
    return str;
  },

  /**
   * Add a compiler `fn` with the given `name`
   */

  set: function(name, fn) {
    this.compilers[name] = fn;
    return this;
  },

  /**
   * Get compiler `name`.
   */

  get: function(name) {
    return this.compilers[name];
  },

  /**
   * Get the previous AST node.
   */

  prev: function(n) {
    return this.ast.nodes[this.idx - (n || 1)] || { type: 'bos', val: '' };
  },

  /**
   * Get the next AST node.
   */

  next: function(n) {
    return this.ast.nodes[this.idx + (n || 1)] || { type: 'eos', val: '' };
  },

  /**
   * Visit `node`.
   */

  visit: function(node, nodes, i) {
    var fn = this.compilers[node.type];
    this.idx = i;

    if (typeof fn !== 'function') {
      throw this.error('compiler "' + node.type + '" is not registered', node);
    }
    return fn.call(this, node, nodes, i);
  },

  /**
   * Map visit over array of `nodes`.
   */

  mapVisit: function(nodes) {
    if (!Array.isArray(nodes)) {
      throw new TypeError('expected an array');
    }
    var len = nodes.length;
    var idx = -1;
    while (++idx < len) {
      this.visit(nodes[idx], nodes, idx);
    }
    return this;
  },

  /**
   * Compile `ast`.
   */

  compile: function(ast, options) {
    var opts = utils.extend({}, this.options, options);
    this.ast = ast;
    this.parsingErrors = this.ast.errors;
    this.output = '';

    // source map support
    if (opts.sourcemap) {
      var sourcemaps = __nccwpck_require__(8240);
      sourcemaps(this);
      this.mapVisit(this.ast.nodes);
      this.applySourceMaps();
      this.map = opts.sourcemap === 'generator' ? this.map : this.map.toJSON();
      return this;
    }

    this.mapVisit(this.ast.nodes);
    return this;
  }
};

/**
 * Expose `Compiler`
 */

module.exports = Compiler;


/***/ }),

/***/ 182:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var use = __nccwpck_require__(9656);
var util = __nccwpck_require__(3837);
var Cache = __nccwpck_require__(4643);
var define = __nccwpck_require__(6967);
var debug = __nccwpck_require__(8237)('snapdragon:parser');
var Position = __nccwpck_require__(6252);
var utils = __nccwpck_require__(3620);

/**
 * Create a new `Parser` with the given `input` and `options`.
 * @param {String} `input`
 * @param {Object} `options`
 * @api public
 */

function Parser(options) {
  debug('initializing', __filename);
  this.options = utils.extend({source: 'string'}, options);
  this.init(this.options);
  use(this);
}

/**
 * Prototype methods
 */

Parser.prototype = {
  constructor: Parser,

  init: function(options) {
    this.orig = '';
    this.input = '';
    this.parsed = '';

    this.column = 1;
    this.line = 1;

    this.regex = new Cache();
    this.errors = this.errors || [];
    this.parsers = this.parsers || {};
    this.types = this.types || [];
    this.sets = this.sets || {};
    this.fns = this.fns || [];
    this.currentType = 'root';

    var pos = this.position();
    this.bos = pos({type: 'bos', val: ''});

    this.ast = {
      type: 'root',
      errors: this.errors,
      nodes: [this.bos]
    };

    define(this.bos, 'parent', this.ast);
    this.nodes = [this.ast];

    this.count = 0;
    this.setCount = 0;
    this.stack = [];
  },

  /**
   * Throw a formatted error with the cursor column and `msg`.
   * @param {String} `msg` Message to use in the Error.
   */

  error: function(msg, node) {
    var pos = node.position || {start: {column: 0, line: 0}};
    var line = pos.start.line;
    var column = pos.start.column;
    var source = this.options.source;

    var message = source + ' <line:' + line + ' column:' + column + '>: ' + msg;
    var err = new Error(message);
    err.source = source;
    err.reason = msg;
    err.pos = pos;

    if (this.options.silent) {
      this.errors.push(err);
    } else {
      throw err;
    }
  },

  /**
   * Define a non-enumberable property on the `Parser` instance.
   *
   * ```js
   * parser.define('foo', 'bar');
   * ```
   * @name .define
   * @param {String} `key` propery name
   * @param {any} `val` property value
   * @return {Object} Returns the Parser instance for chaining.
   * @api public
   */

  define: function(key, val) {
    define(this, key, val);
    return this;
  },

  /**
   * Mark position and patch `node.position`.
   */

  position: function() {
    var start = { line: this.line, column: this.column };
    var self = this;

    return function(node) {
      define(node, 'position', new Position(start, self));
      return node;
    };
  },

  /**
   * Set parser `name` with the given `fn`
   * @param {String} `name`
   * @param {Function} `fn`
   * @api public
   */

  set: function(type, fn) {
    if (this.types.indexOf(type) === -1) {
      this.types.push(type);
    }
    this.parsers[type] = fn.bind(this);
    return this;
  },

  /**
   * Get parser `name`
   * @param {String} `name`
   * @api public
   */

  get: function(name) {
    return this.parsers[name];
  },

  /**
   * Push a `token` onto the `type` stack.
   *
   * @param {String} `type`
   * @return {Object} `token`
   * @api public
   */

  push: function(type, token) {
    this.sets[type] = this.sets[type] || [];
    this.count++;
    this.stack.push(token);
    return this.sets[type].push(token);
  },

  /**
   * Pop a token off of the `type` stack
   * @param {String} `type`
   * @returns {Object} Returns a token
   * @api public
   */

  pop: function(type) {
    this.sets[type] = this.sets[type] || [];
    this.count--;
    this.stack.pop();
    return this.sets[type].pop();
  },

  /**
   * Return true if inside a `stack` node. Types are `braces`, `parens` or `brackets`.
   *
   * @param {String} `type`
   * @return {Boolean}
   * @api public
   */

  isInside: function(type) {
    this.sets[type] = this.sets[type] || [];
    return this.sets[type].length > 0;
  },

  /**
   * Return true if `node` is the given `type`.
   *
   * ```js
   * parser.isType(node, 'brace');
   * ```
   * @param {Object} `node`
   * @param {String} `type`
   * @return {Boolean}
   * @api public
   */

  isType: function(node, type) {
    return node && node.type === type;
  },

  /**
   * Get the previous AST node
   * @return {Object}
   */

  prev: function(n) {
    return this.stack.length > 0
      ? utils.last(this.stack, n)
      : utils.last(this.nodes, n);
  },

  /**
   * Update line and column based on `str`.
   */

  consume: function(len) {
    this.input = this.input.substr(len);
  },

  /**
   * Update column based on `str`.
   */

  updatePosition: function(str, len) {
    var lines = str.match(/\n/g);
    if (lines) this.line += lines.length;
    var i = str.lastIndexOf('\n');
    this.column = ~i ? len - i : this.column + len;
    this.parsed += str;
    this.consume(len);
  },

  /**
   * Match `regex`, return captures, and update the cursor position by `match[0]` length.
   * @param {RegExp} `regex`
   * @return {Object}
   */

  match: function(regex) {
    var m = regex.exec(this.input);
    if (m) {
      this.updatePosition(m[0], m[0].length);
      return m;
    }
  },

  /**
   * Capture `type` with the given regex.
   * @param {String} `type`
   * @param {RegExp} `regex`
   * @return {Function}
   */

  capture: function(type, regex) {
    if (typeof regex === 'function') {
      return this.set.apply(this, arguments);
    }

    this.regex.set(type, regex);
    this.set(type, function() {
      var parsed = this.parsed;
      var pos = this.position();
      var m = this.match(regex);
      if (!m || !m[0]) return;

      var prev = this.prev();
      var node = pos({
        type: type,
        val: m[0],
        parsed: parsed,
        rest: this.input
      });

      if (m[1]) {
        node.inner = m[1];
      }

      define(node, 'inside', this.stack.length > 0);
      define(node, 'parent', prev);
      prev.nodes.push(node);
    }.bind(this));
    return this;
  },

  /**
   * Create a parser with open and close for parens,
   * brackets or braces
   */

  capturePair: function(type, openRegex, closeRegex, fn) {
    this.sets[type] = this.sets[type] || [];

    /**
     * Open
     */

    this.set(type + '.open', function() {
      var parsed = this.parsed;
      var pos = this.position();
      var m = this.match(openRegex);
      if (!m || !m[0]) return;

      var val = m[0];
      this.setCount++;
      this.specialChars = true;
      var open = pos({
        type: type + '.open',
        val: val,
        rest: this.input
      });

      if (typeof m[1] !== 'undefined') {
        open.inner = m[1];
      }

      var prev = this.prev();
      var node = pos({
        type: type,
        nodes: [open]
      });

      define(node, 'rest', this.input);
      define(node, 'parsed', parsed);
      define(node, 'prefix', m[1]);
      define(node, 'parent', prev);
      define(open, 'parent', node);

      if (typeof fn === 'function') {
        fn.call(this, open, node);
      }

      this.push(type, node);
      prev.nodes.push(node);
    });

    /**
     * Close
     */

    this.set(type + '.close', function() {
      var pos = this.position();
      var m = this.match(closeRegex);
      if (!m || !m[0]) return;

      var parent = this.pop(type);
      var node = pos({
        type: type + '.close',
        rest: this.input,
        suffix: m[1],
        val: m[0]
      });

      if (!this.isType(parent, type)) {
        if (this.options.strict) {
          throw new Error('missing opening "' + type + '"');
        }

        this.setCount--;
        node.escaped = true;
        return node;
      }

      if (node.suffix === '\\') {
        parent.escaped = true;
        node.escaped = true;
      }

      parent.nodes.push(node);
      define(node, 'parent', parent);
    });

    return this;
  },

  /**
   * Capture end-of-string
   */

  eos: function() {
    var pos = this.position();
    if (this.input) return;
    var prev = this.prev();

    while (prev.type !== 'root' && !prev.visited) {
      if (this.options.strict === true) {
        throw new SyntaxError('invalid syntax:' + util.inspect(prev, null, 2));
      }

      if (!hasDelims(prev)) {
        prev.parent.escaped = true;
        prev.escaped = true;
      }

      visit(prev, function(node) {
        if (!hasDelims(node.parent)) {
          node.parent.escaped = true;
          node.escaped = true;
        }
      });

      prev = prev.parent;
    }

    var tok = pos({
      type: 'eos',
      val: this.append || ''
    });

    define(tok, 'parent', this.ast);
    return tok;
  },

  /**
   * Run parsers to advance the cursor position
   */

  next: function() {
    var parsed = this.parsed;
    var len = this.types.length;
    var idx = -1;
    var tok;

    while (++idx < len) {
      if ((tok = this.parsers[this.types[idx]].call(this))) {
        define(tok, 'rest', this.input);
        define(tok, 'parsed', parsed);
        this.last = tok;
        return tok;
      }
    }
  },

  /**
   * Parse the given string.
   * @return {Array}
   */

  parse: function(input) {
    if (typeof input !== 'string') {
      throw new TypeError('expected a string');
    }

    this.init(this.options);
    this.orig = input;
    this.input = input;
    var self = this;

    function parse() {
      // check input before calling `.next()`
      input = self.input;

      // get the next AST ndoe
      var node = self.next();
      if (node) {
        var prev = self.prev();
        if (prev) {
          define(node, 'parent', prev);
          if (prev.nodes) {
            prev.nodes.push(node);
          }
        }

        if (self.sets.hasOwnProperty(prev.type)) {
          self.currentType = prev.type;
        }
      }

      // if we got here but input is not changed, throw an error
      if (self.input && input === self.input) {
        throw new Error('no parsers registered for: "' + self.input.slice(0, 5) + '"');
      }
    }

    while (this.input) parse();
    if (this.stack.length && this.options.strict) {
      var node = this.stack.pop();
      throw this.error('missing opening ' + node.type + ': "' + this.orig + '"');
    }

    var eos = this.eos();
    var tok = this.prev();
    if (tok.type !== 'eos') {
      this.ast.nodes.push(eos);
    }

    return this.ast;
  }
};

/**
 * Visit `node` with the given `fn`
 */

function visit(node, fn) {
  if (!node.visited) {
    define(node, 'visited', true);
    return node.nodes ? mapVisit(node.nodes, fn) : fn(node);
  }
  return node;
}

/**
 * Map visit over array of `nodes`.
 */

function mapVisit(nodes, fn) {
  var len = nodes.length;
  var idx = -1;
  while (++idx < len) {
    visit(nodes[idx], fn);
  }
}

function hasOpen(node) {
  return node.nodes && node.nodes[0].type === (node.type + '.open');
}

function hasClose(node) {
  return node.nodes && utils.last(node.nodes).type === (node.type + '.close');
}

function hasDelims(node) {
  return hasOpen(node) && hasClose(node);
}

/**
 * Expose `Parser`
 */

module.exports = Parser;


/***/ }),

/***/ 6252:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var define = __nccwpck_require__(6967);

/**
 * Store position for a node
 */

module.exports = function Position(start, parser) {
  this.start = start;
  this.end = { line: parser.line, column: parser.column };
  define(this, 'content', parser.orig);
  define(this, 'source', parser.options.source);
};


/***/ }),

/***/ 8240:
/***/ ((module, exports, __nccwpck_require__) => {



var fs = __nccwpck_require__(7147);
var path = __nccwpck_require__(1017);
var define = __nccwpck_require__(6967);
var utils = __nccwpck_require__(3620);

/**
 * Expose `mixin()`.
 * This code is based on `source-maps-support.js` in reworkcss/css
 * https://github.com/reworkcss/css/blob/master/lib/stringify/source-map-support.js
 * Copyright (c) 2012 TJ Holowaychuk <tj@vision-media.ca>
 */

module.exports = mixin;

/**
 * Mixin source map support into `compiler`.
 *
 * @param {Object} `compiler`
 * @api public
 */

function mixin(compiler) {
  define(compiler, '_comment', compiler.comment);
  compiler.map = new utils.SourceMap.SourceMapGenerator();
  compiler.position = { line: 1, column: 1 };
  compiler.content = {};
  compiler.files = {};

  for (var key in exports) {
    define(compiler, key, exports[key]);
  }
}

/**
 * Update position.
 *
 * @param {String} str
 */

exports.updatePosition = function(str) {
  var lines = str.match(/\n/g);
  if (lines) this.position.line += lines.length;
  var i = str.lastIndexOf('\n');
  this.position.column = ~i ? str.length - i : this.position.column + str.length;
};

/**
 * Emit `str` with `position`.
 *
 * @param {String} str
 * @param {Object} [pos]
 * @return {String}
 */

exports.emit = function(str, node) {
  var position = node.position || {};
  var source = position.source;
  if (source) {
    if (position.filepath) {
      source = utils.unixify(position.filepath);
    }

    this.map.addMapping({
      source: source,
      generated: {
        line: this.position.line,
        column: Math.max(this.position.column - 1, 0)
      },
      original: {
        line: position.start.line,
        column: position.start.column - 1
      }
    });

    if (position.content) {
      this.addContent(source, position);
    }
    if (position.filepath) {
      this.addFile(source, position);
    }

    this.updatePosition(str);
    this.output += str;
  }
  return str;
};

/**
 * Adds a file to the source map output if it has not already been added
 * @param {String} `file`
 * @param {Object} `pos`
 */

exports.addFile = function(file, position) {
  if (typeof position.content !== 'string') return;
  if (Object.prototype.hasOwnProperty.call(this.files, file)) return;
  this.files[file] = position.content;
};

/**
 * Adds a content source to the source map output if it has not already been added
 * @param {String} `source`
 * @param {Object} `position`
 */

exports.addContent = function(source, position) {
  if (typeof position.content !== 'string') return;
  if (Object.prototype.hasOwnProperty.call(this.content, source)) return;
  this.map.setSourceContent(source, position.content);
};

/**
 * Applies any original source maps to the output and embeds the source file
 * contents in the source map.
 */

exports.applySourceMaps = function() {
  Object.keys(this.files).forEach(function(file) {
    var content = this.files[file];
    this.map.setSourceContent(file, content);

    if (this.options.inputSourcemaps === true) {
      var originalMap = utils.sourceMapResolve.resolveSync(content, file, fs.readFileSync);
      if (originalMap) {
        var map = new utils.SourceMap.SourceMapConsumer(originalMap.map);
        var relativeTo = originalMap.sourcesRelativeTo;
        this.map.applySourceMap(map, file, utils.unixify(path.dirname(relativeTo)));
      }
    }
  }, this);
};

/**
 * Process comments, drops sourceMap comments.
 * @param {Object} node
 */

exports.comment = function(node) {
  if (/^# sourceMappingURL=/.test(node.comment)) {
    return this.emit('', node.position);
  }
  return this._comment(node);
};


/***/ }),

/***/ 3620:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {



/**
 * Module dependencies
 */

exports.extend = __nccwpck_require__(7512);
exports.SourceMap = __nccwpck_require__(6594);
exports.sourceMapResolve = __nccwpck_require__(3649);

/**
 * Convert backslash in the given string to forward slashes
 */

exports.unixify = function(fp) {
  return fp.split(/\\+/).join('/');
};

/**
 * Return true if `val` is a non-empty string
 *
 * @param {String} `str`
 * @return {Boolean}
 */

exports.isString = function(str) {
  return str && typeof str === 'string';
};

/**
 * Cast `val` to an array
 * @return {Array}
 */

exports.arrayify = function(val) {
  if (typeof val === 'string') return [val];
  return val ? (Array.isArray(val) ? val : [val]) : [];
};

/**
 * Get the last `n` element from the given `array`
 * @param {Array} `array`
 * @return {*}
 */

exports.last = function(arr, n) {
  return arr[arr.length - (n || 1)];
};


/***/ }),

/***/ 4811:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

var decodeUriComponent = __nccwpck_require__(3186)

function customDecodeUriComponent(string) {
  // `decodeUriComponent` turns `+` into ` `, but that's not wanted.
  return decodeUriComponent(string.replace(/\+/g, "%2B"))
}

module.exports = customDecodeUriComponent


/***/ }),

/***/ 2629:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

var url = __nccwpck_require__(7310)

function resolveUrl(/* ...urls */) {
  return Array.prototype.reduce.call(arguments, function(resolved, nextUrl) {
    return url.resolve(resolved, nextUrl)
  })
}

module.exports = resolveUrl


/***/ }),

/***/ 3649:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

var sourceMappingURL   = __nccwpck_require__(6598)

var resolveUrl         = __nccwpck_require__(2629)
var decodeUriComponent = __nccwpck_require__(4811)
var urix               = __nccwpck_require__(8987)
var atob               = __nccwpck_require__(161)



function callbackAsync(callback, error, result) {
  setImmediate(function() { callback(error, result) })
}

function parseMapToJSON(string, data) {
  try {
    return JSON.parse(string.replace(/^\)\]\}'/, ""))
  } catch (error) {
    error.sourceMapData = data
    throw error
  }
}

function readSync(read, url, data) {
  var readUrl = decodeUriComponent(url)
  try {
    return String(read(readUrl))
  } catch (error) {
    error.sourceMapData = data
    throw error
  }
}



function resolveSourceMap(code, codeUrl, read, callback) {
  var mapData
  try {
    mapData = resolveSourceMapHelper(code, codeUrl)
  } catch (error) {
    return callbackAsync(callback, error)
  }
  if (!mapData || mapData.map) {
    return callbackAsync(callback, null, mapData)
  }
  var readUrl = decodeUriComponent(mapData.url)
  read(readUrl, function(error, result) {
    if (error) {
      error.sourceMapData = mapData
      return callback(error)
    }
    mapData.map = String(result)
    try {
      mapData.map = parseMapToJSON(mapData.map, mapData)
    } catch (error) {
      return callback(error)
    }
    callback(null, mapData)
  })
}

function resolveSourceMapSync(code, codeUrl, read) {
  var mapData = resolveSourceMapHelper(code, codeUrl)
  if (!mapData || mapData.map) {
    return mapData
  }
  mapData.map = readSync(read, mapData.url, mapData)
  mapData.map = parseMapToJSON(mapData.map, mapData)
  return mapData
}

var dataUriRegex = /^data:([^,;]*)(;[^,;]*)*(?:,(.*))?$/

/**
 * The media type for JSON text is application/json.
 *
 * {@link https://tools.ietf.org/html/rfc8259#section-11 | IANA Considerations }
 *
 * `text/json` is non-standard media type
 */
var jsonMimeTypeRegex = /^(?:application|text)\/json$/

/**
 * JSON text exchanged between systems that are not part of a closed ecosystem
 * MUST be encoded using UTF-8.
 *
 * {@link https://tools.ietf.org/html/rfc8259#section-8.1 | Character Encoding}
 */
var jsonCharacterEncoding = "utf-8"

function base64ToBuf(b64) {
  var binStr = atob(b64)
  var len = binStr.length
  var arr = new Uint8Array(len)
  for (var i = 0; i < len; i++) {
    arr[i] = binStr.charCodeAt(i)
  }
  return arr
}

function decodeBase64String(b64) {
  if (typeof TextDecoder === "undefined" || typeof Uint8Array === "undefined") {
    return atob(b64)
  }
  var buf = base64ToBuf(b64);
  // Note: `decoder.decode` method will throw a `DOMException` with the
  // `"EncodingError"` value when an coding error is found.
  var decoder = new TextDecoder(jsonCharacterEncoding, {fatal: true})
  return decoder.decode(buf);
}

function resolveSourceMapHelper(code, codeUrl) {
  codeUrl = urix(codeUrl)

  var url = sourceMappingURL.getFrom(code)
  if (!url) {
    return null
  }

  var dataUri = url.match(dataUriRegex)
  if (dataUri) {
    var mimeType = dataUri[1] || "text/plain"
    var lastParameter = dataUri[2] || ""
    var encoded = dataUri[3] || ""
    var data = {
      sourceMappingURL: url,
      url: null,
      sourcesRelativeTo: codeUrl,
      map: encoded
    }
    if (!jsonMimeTypeRegex.test(mimeType)) {
      var error = new Error("Unuseful data uri mime type: " + mimeType)
      error.sourceMapData = data
      throw error
    }
    try {
      data.map = parseMapToJSON(
        lastParameter === ";base64" ? decodeBase64String(encoded) : decodeURIComponent(encoded),
        data
      )
    } catch (error) {
      error.sourceMapData = data
      throw error
    }
    return data
  }

  var mapUrl = resolveUrl(codeUrl, url)
  return {
    sourceMappingURL: url,
    url: mapUrl,
    sourcesRelativeTo: mapUrl,
    map: null
  }
}



function resolveSources(map, mapUrl, read, options, callback) {
  if (typeof options === "function") {
    callback = options
    options = {}
  }
  var pending = map.sources ? map.sources.length : 0
  var result = {
    sourcesResolved: [],
    sourcesContent:  []
  }

  if (pending === 0) {
    callbackAsync(callback, null, result)
    return
  }

  var done = function() {
    pending--
    if (pending === 0) {
      callback(null, result)
    }
  }

  resolveSourcesHelper(map, mapUrl, options, function(fullUrl, sourceContent, index) {
    result.sourcesResolved[index] = fullUrl
    if (typeof sourceContent === "string") {
      result.sourcesContent[index] = sourceContent
      callbackAsync(done, null)
    } else {
      var readUrl = decodeUriComponent(fullUrl)
      read(readUrl, function(error, source) {
        result.sourcesContent[index] = error ? error : String(source)
        done()
      })
    }
  })
}

function resolveSourcesSync(map, mapUrl, read, options) {
  var result = {
    sourcesResolved: [],
    sourcesContent:  []
  }

  if (!map.sources || map.sources.length === 0) {
    return result
  }

  resolveSourcesHelper(map, mapUrl, options, function(fullUrl, sourceContent, index) {
    result.sourcesResolved[index] = fullUrl
    if (read !== null) {
      if (typeof sourceContent === "string") {
        result.sourcesContent[index] = sourceContent
      } else {
        var readUrl = decodeUriComponent(fullUrl)
        try {
          result.sourcesContent[index] = String(read(readUrl))
        } catch (error) {
          result.sourcesContent[index] = error
        }
      }
    }
  })

  return result
}

var endingSlash = /\/?$/

function resolveSourcesHelper(map, mapUrl, options, fn) {
  options = options || {}
  mapUrl = urix(mapUrl)
  var fullUrl
  var sourceContent
  var sourceRoot
  for (var index = 0, len = map.sources.length; index < len; index++) {
    sourceRoot = null
    if (typeof options.sourceRoot === "string") {
      sourceRoot = options.sourceRoot
    } else if (typeof map.sourceRoot === "string" && options.sourceRoot !== false) {
      sourceRoot = map.sourceRoot
    }
    // If the sourceRoot is the empty string, it is equivalent to not setting
    // the property at all.
    if (sourceRoot === null || sourceRoot === '') {
      fullUrl = resolveUrl(mapUrl, map.sources[index])
    } else {
      // Make sure that the sourceRoot ends with a slash, so that `/scripts/subdir` becomes
      // `/scripts/subdir/<source>`, not `/scripts/<source>`. Pointing to a file as source root
      // does not make sense.
      fullUrl = resolveUrl(mapUrl, sourceRoot.replace(endingSlash, "/"), map.sources[index])
    }
    sourceContent = (map.sourcesContent || [])[index]
    fn(fullUrl, sourceContent, index)
  }
}



function resolve(code, codeUrl, read, options, callback) {
  if (typeof options === "function") {
    callback = options
    options = {}
  }
  if (code === null) {
    var mapUrl = codeUrl
    var data = {
      sourceMappingURL: null,
      url: mapUrl,
      sourcesRelativeTo: mapUrl,
      map: null
    }
    var readUrl = decodeUriComponent(mapUrl)
    read(readUrl, function(error, result) {
      if (error) {
        error.sourceMapData = data
        return callback(error)
      }
      data.map = String(result)
      try {
        data.map = parseMapToJSON(data.map, data)
      } catch (error) {
        return callback(error)
      }
      _resolveSources(data)
    })
  } else {
    resolveSourceMap(code, codeUrl, read, function(error, mapData) {
      if (error) {
        return callback(error)
      }
      if (!mapData) {
        return callback(null, null)
      }
      _resolveSources(mapData)
    })
  }

  function _resolveSources(mapData) {
    resolveSources(mapData.map, mapData.sourcesRelativeTo, read, options, function(error, result) {
      if (error) {
        return callback(error)
      }
      mapData.sourcesResolved = result.sourcesResolved
      mapData.sourcesContent  = result.sourcesContent
      callback(null, mapData)
    })
  }
}

function resolveSync(code, codeUrl, read, options) {
  var mapData
  if (code === null) {
    var mapUrl = codeUrl
    mapData = {
      sourceMappingURL: null,
      url: mapUrl,
      sourcesRelativeTo: mapUrl,
      map: null
    }
    mapData.map = readSync(read, mapUrl, mapData)
    mapData.map = parseMapToJSON(mapData.map, mapData)
  } else {
    mapData = resolveSourceMapSync(code, codeUrl, read)
    if (!mapData) {
      return null
    }
  }
  var result = resolveSourcesSync(mapData.map, mapData.sourcesRelativeTo, read, options)
  mapData.sourcesResolved = result.sourcesResolved
  mapData.sourcesContent  = result.sourcesContent
  return mapData
}



module.exports = {
  resolveSourceMap:     resolveSourceMap,
  resolveSourceMapSync: resolveSourceMapSync,
  resolveSources:       resolveSources,
  resolveSourcesSync:   resolveSourcesSync,
  resolve:              resolve,
  resolveSync:          resolveSync,
  parseMapToJSON:       parseMapToJSON
}


/***/ }),

/***/ 6598:
/***/ (function(module) {

// Copyright 2014 Simon Lydell
// X11 (“MIT”) Licensed. (See LICENSE.)

void (function(root, factory) {
  if (typeof define === "function" && define.amd) {
    define(factory)
  } else if (true) {
    module.exports = factory()
  } else {}
}(this, function() {

  var innerRegex = /[#@] sourceMappingURL=([^\s'"]*)/

  var regex = RegExp(
    "(?:" +
      "/\\*" +
      "(?:\\s*\r?\n(?://)?)?" +
      "(?:" + innerRegex.source + ")" +
      "\\s*" +
      "\\*/" +
      "|" +
      "//(?:" + innerRegex.source + ")" +
    ")" +
    "\\s*"
  )

  return {

    regex: regex,
    _innerRegex: innerRegex,

    getFrom: function(code) {
      var match = code.match(regex)
      return (match ? match[1] || match[2] || "" : null)
    },

    existsIn: function(code) {
      return regex.test(code)
    },

    removeFrom: function(code) {
      return code.replace(regex, "")
    },

    insertBefore: function(code, string) {
      var match = code.match(regex)
      if (match) {
        return code.slice(0, match.index) + string + code.slice(match.index)
      } else {
        return code + string
      }
    }
  }

}));


/***/ }),

/***/ 6375:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {

/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */

var util = __nccwpck_require__(2344);
var has = Object.prototype.hasOwnProperty;
var hasNativeMap = typeof Map !== "undefined";

/**
 * A data structure which is a combination of an array and a set. Adding a new
 * member is O(1), testing for membership is O(1), and finding the index of an
 * element is O(1). Removing elements from the set is not supported. Only
 * strings are supported for membership.
 */
function ArraySet() {
  this._array = [];
  this._set = hasNativeMap ? new Map() : Object.create(null);
}

/**
 * Static method for creating ArraySet instances from an existing array.
 */
ArraySet.fromArray = function ArraySet_fromArray(aArray, aAllowDuplicates) {
  var set = new ArraySet();
  for (var i = 0, len = aArray.length; i < len; i++) {
    set.add(aArray[i], aAllowDuplicates);
  }
  return set;
};

/**
 * Return how many unique items are in this ArraySet. If duplicates have been
 * added, than those do not count towards the size.
 *
 * @returns Number
 */
ArraySet.prototype.size = function ArraySet_size() {
  return hasNativeMap ? this._set.size : Object.getOwnPropertyNames(this._set).length;
};

/**
 * Add the given string to this set.
 *
 * @param String aStr
 */
ArraySet.prototype.add = function ArraySet_add(aStr, aAllowDuplicates) {
  var sStr = hasNativeMap ? aStr : util.toSetString(aStr);
  var isDuplicate = hasNativeMap ? this.has(aStr) : has.call(this._set, sStr);
  var idx = this._array.length;
  if (!isDuplicate || aAllowDuplicates) {
    this._array.push(aStr);
  }
  if (!isDuplicate) {
    if (hasNativeMap) {
      this._set.set(aStr, idx);
    } else {
      this._set[sStr] = idx;
    }
  }
};

/**
 * Is the given string a member of this set?
 *
 * @param String aStr
 */
ArraySet.prototype.has = function ArraySet_has(aStr) {
  if (hasNativeMap) {
    return this._set.has(aStr);
  } else {
    var sStr = util.toSetString(aStr);
    return has.call(this._set, sStr);
  }
};

/**
 * What is the index of the given string in the array?
 *
 * @param String aStr
 */
ArraySet.prototype.indexOf = function ArraySet_indexOf(aStr) {
  if (hasNativeMap) {
    var idx = this._set.get(aStr);
    if (idx >= 0) {
        return idx;
    }
  } else {
    var sStr = util.toSetString(aStr);
    if (has.call(this._set, sStr)) {
      return this._set[sStr];
    }
  }

  throw new Error('"' + aStr + '" is not in the set.');
};

/**
 * What is the element at the given index?
 *
 * @param Number aIdx
 */
ArraySet.prototype.at = function ArraySet_at(aIdx) {
  if (aIdx >= 0 && aIdx < this._array.length) {
    return this._array[aIdx];
  }
  throw new Error('No element indexed by ' + aIdx);
};

/**
 * Returns the array representation of this set (which has the proper indices
 * indicated by indexOf). Note that this is a copy of the internal array used
 * for storing the members so that no one can mess with internal state.
 */
ArraySet.prototype.toArray = function ArraySet_toArray() {
  return this._array.slice();
};

exports.I = ArraySet;


/***/ }),

/***/ 975:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {

/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 *
 * Based on the Base 64 VLQ implementation in Closure Compiler:
 * https://code.google.com/p/closure-compiler/source/browse/trunk/src/com/google/debugging/sourcemap/Base64VLQ.java
 *
 * Copyright 2011 The Closure Compiler Authors. All rights reserved.
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *  * Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above
 *    copyright notice, this list of conditions and the following
 *    disclaimer in the documentation and/or other materials provided
 *    with the distribution.
 *  * Neither the name of Google Inc. nor the names of its
 *    contributors may be used to endorse or promote products derived
 *    from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

var base64 = __nccwpck_require__(6156);

// A single base 64 digit can contain 6 bits of data. For the base 64 variable
// length quantities we use in the source map spec, the first bit is the sign,
// the next four bits are the actual value, and the 6th bit is the
// continuation bit. The continuation bit tells us whether there are more
// digits in this value following this digit.
//
//   Continuation
//   |    Sign
//   |    |
//   V    V
//   101011

var VLQ_BASE_SHIFT = 5;

// binary: 100000
var VLQ_BASE = 1 << VLQ_BASE_SHIFT;

// binary: 011111
var VLQ_BASE_MASK = VLQ_BASE - 1;

// binary: 100000
var VLQ_CONTINUATION_BIT = VLQ_BASE;

/**
 * Converts from a two-complement value to a value where the sign bit is
 * placed in the least significant bit.  For example, as decimals:
 *   1 becomes 2 (10 binary), -1 becomes 3 (11 binary)
 *   2 becomes 4 (100 binary), -2 becomes 5 (101 binary)
 */
function toVLQSigned(aValue) {
  return aValue < 0
    ? ((-aValue) << 1) + 1
    : (aValue << 1) + 0;
}

/**
 * Converts to a two-complement value from a value where the sign bit is
 * placed in the least significant bit.  For example, as decimals:
 *   2 (10 binary) becomes 1, 3 (11 binary) becomes -1
 *   4 (100 binary) becomes 2, 5 (101 binary) becomes -2
 */
function fromVLQSigned(aValue) {
  var isNegative = (aValue & 1) === 1;
  var shifted = aValue >> 1;
  return isNegative
    ? -shifted
    : shifted;
}

/**
 * Returns the base 64 VLQ encoded value.
 */
exports.encode = function base64VLQ_encode(aValue) {
  var encoded = "";
  var digit;

  var vlq = toVLQSigned(aValue);

  do {
    digit = vlq & VLQ_BASE_MASK;
    vlq >>>= VLQ_BASE_SHIFT;
    if (vlq > 0) {
      // There are still more digits in this value, so we must make sure the
      // continuation bit is marked.
      digit |= VLQ_CONTINUATION_BIT;
    }
    encoded += base64.encode(digit);
  } while (vlq > 0);

  return encoded;
};

/**
 * Decodes the next base 64 VLQ value from the given string and returns the
 * value and the rest of the string via the out parameter.
 */
exports.decode = function base64VLQ_decode(aStr, aIndex, aOutParam) {
  var strLen = aStr.length;
  var result = 0;
  var shift = 0;
  var continuation, digit;

  do {
    if (aIndex >= strLen) {
      throw new Error("Expected more digits in base 64 VLQ value.");
    }

    digit = base64.decode(aStr.charCodeAt(aIndex++));
    if (digit === -1) {
      throw new Error("Invalid base64 digit: " + aStr.charAt(aIndex - 1));
    }

    continuation = !!(digit & VLQ_CONTINUATION_BIT);
    digit &= VLQ_BASE_MASK;
    result = result + (digit << shift);
    shift += VLQ_BASE_SHIFT;
  } while (continuation);

  aOutParam.value = fromVLQSigned(result);
  aOutParam.rest = aIndex;
};


/***/ }),

/***/ 6156:
/***/ ((__unused_webpack_module, exports) => {

/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */

var intToCharMap = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('');

/**
 * Encode an integer in the range of 0 to 63 to a single base 64 digit.
 */
exports.encode = function (number) {
  if (0 <= number && number < intToCharMap.length) {
    return intToCharMap[number];
  }
  throw new TypeError("Must be between 0 and 63: " + number);
};

/**
 * Decode a single base 64 character code digit to an integer. Returns -1 on
 * failure.
 */
exports.decode = function (charCode) {
  var bigA = 65;     // 'A'
  var bigZ = 90;     // 'Z'

  var littleA = 97;  // 'a'
  var littleZ = 122; // 'z'

  var zero = 48;     // '0'
  var nine = 57;     // '9'

  var plus = 43;     // '+'
  var slash = 47;    // '/'

  var littleOffset = 26;
  var numberOffset = 52;

  // 0 - 25: ABCDEFGHIJKLMNOPQRSTUVWXYZ
  if (bigA <= charCode && charCode <= bigZ) {
    return (charCode - bigA);
  }

  // 26 - 51: abcdefghijklmnopqrstuvwxyz
  if (littleA <= charCode && charCode <= littleZ) {
    return (charCode - littleA + littleOffset);
  }

  // 52 - 61: 0123456789
  if (zero <= charCode && charCode <= nine) {
    return (charCode - zero + numberOffset);
  }

  // 62: +
  if (charCode == plus) {
    return 62;
  }

  // 63: /
  if (charCode == slash) {
    return 63;
  }

  // Invalid base64 digit.
  return -1;
};


/***/ }),

/***/ 3600:
/***/ ((__unused_webpack_module, exports) => {

/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */

exports.GREATEST_LOWER_BOUND = 1;
exports.LEAST_UPPER_BOUND = 2;

/**
 * Recursive implementation of binary search.
 *
 * @param aLow Indices here and lower do not contain the needle.
 * @param aHigh Indices here and higher do not contain the needle.
 * @param aNeedle The element being searched for.
 * @param aHaystack The non-empty array being searched.
 * @param aCompare Function which takes two elements and returns -1, 0, or 1.
 * @param aBias Either 'binarySearch.GREATEST_LOWER_BOUND' or
 *     'binarySearch.LEAST_UPPER_BOUND'. Specifies whether to return the
 *     closest element that is smaller than or greater than the one we are
 *     searching for, respectively, if the exact element cannot be found.
 */
function recursiveSearch(aLow, aHigh, aNeedle, aHaystack, aCompare, aBias) {
  // This function terminates when one of the following is true:
  //
  //   1. We find the exact element we are looking for.
  //
  //   2. We did not find the exact element, but we can return the index of
  //      the next-closest element.
  //
  //   3. We did not find the exact element, and there is no next-closest
  //      element than the one we are searching for, so we return -1.
  var mid = Math.floor((aHigh - aLow) / 2) + aLow;
  var cmp = aCompare(aNeedle, aHaystack[mid], true);
  if (cmp === 0) {
    // Found the element we are looking for.
    return mid;
  }
  else if (cmp > 0) {
    // Our needle is greater than aHaystack[mid].
    if (aHigh - mid > 1) {
      // The element is in the upper half.
      return recursiveSearch(mid, aHigh, aNeedle, aHaystack, aCompare, aBias);
    }

    // The exact needle element was not found in this haystack. Determine if
    // we are in termination case (3) or (2) and return the appropriate thing.
    if (aBias == exports.LEAST_UPPER_BOUND) {
      return aHigh < aHaystack.length ? aHigh : -1;
    } else {
      return mid;
    }
  }
  else {
    // Our needle is less than aHaystack[mid].
    if (mid - aLow > 1) {
      // The element is in the lower half.
      return recursiveSearch(aLow, mid, aNeedle, aHaystack, aCompare, aBias);
    }

    // we are in termination case (3) or (2) and return the appropriate thing.
    if (aBias == exports.LEAST_UPPER_BOUND) {
      return mid;
    } else {
      return aLow < 0 ? -1 : aLow;
    }
  }
}

/**
 * This is an implementation of binary search which will always try and return
 * the index of the closest element if there is no exact hit. This is because
 * mappings between original and generated line/col pairs are single points,
 * and there is an implicit region between each of them, so a miss just means
 * that you aren't on the very start of a region.
 *
 * @param aNeedle The element you are looking for.
 * @param aHaystack The array that is being searched.
 * @param aCompare A function which takes the needle and an element in the
 *     array and returns -1, 0, or 1 depending on whether the needle is less
 *     than, equal to, or greater than the element, respectively.
 * @param aBias Either 'binarySearch.GREATEST_LOWER_BOUND' or
 *     'binarySearch.LEAST_UPPER_BOUND'. Specifies whether to return the
 *     closest element that is smaller than or greater than the one we are
 *     searching for, respectively, if the exact element cannot be found.
 *     Defaults to 'binarySearch.GREATEST_LOWER_BOUND'.
 */
exports.search = function search(aNeedle, aHaystack, aCompare, aBias) {
  if (aHaystack.length === 0) {
    return -1;
  }

  var index = recursiveSearch(-1, aHaystack.length, aNeedle, aHaystack,
                              aCompare, aBias || exports.GREATEST_LOWER_BOUND);
  if (index < 0) {
    return -1;
  }

  // We have found either the exact element, or the next-closest element than
  // the one we are searching for. However, there may be more than one such
  // element. Make sure we always return the smallest of these.
  while (index - 1 >= 0) {
    if (aCompare(aHaystack[index], aHaystack[index - 1], true) !== 0) {
      break;
    }
    --index;
  }

  return index;
};


/***/ }),

/***/ 6817:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {

/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2014 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */

var util = __nccwpck_require__(2344);

/**
 * Determine whether mappingB is after mappingA with respect to generated
 * position.
 */
function generatedPositionAfter(mappingA, mappingB) {
  // Optimized for most common case
  var lineA = mappingA.generatedLine;
  var lineB = mappingB.generatedLine;
  var columnA = mappingA.generatedColumn;
  var columnB = mappingB.generatedColumn;
  return lineB > lineA || lineB == lineA && columnB >= columnA ||
         util.compareByGeneratedPositionsInflated(mappingA, mappingB) <= 0;
}

/**
 * A data structure to provide a sorted view of accumulated mappings in a
 * performance conscious manner. It trades a neglibable overhead in general
 * case for a large speedup in case of mappings being added in order.
 */
function MappingList() {
  this._array = [];
  this._sorted = true;
  // Serves as infimum
  this._last = {generatedLine: -1, generatedColumn: 0};
}

/**
 * Iterate through internal items. This method takes the same arguments that
 * `Array.prototype.forEach` takes.
 *
 * NOTE: The order of the mappings is NOT guaranteed.
 */
MappingList.prototype.unsortedForEach =
  function MappingList_forEach(aCallback, aThisArg) {
    this._array.forEach(aCallback, aThisArg);
  };

/**
 * Add the given source mapping.
 *
 * @param Object aMapping
 */
MappingList.prototype.add = function MappingList_add(aMapping) {
  if (generatedPositionAfter(this._last, aMapping)) {
    this._last = aMapping;
    this._array.push(aMapping);
  } else {
    this._sorted = false;
    this._array.push(aMapping);
  }
};

/**
 * Returns the flat, sorted array of mappings. The mappings are sorted by
 * generated position.
 *
 * WARNING: This method returns internal data without copying, for
 * performance. The return value must NOT be mutated, and should be treated as
 * an immutable borrow. If you want to take ownership, you must make your own
 * copy.
 */
MappingList.prototype.toArray = function MappingList_toArray() {
  if (!this._sorted) {
    this._array.sort(util.compareByGeneratedPositionsInflated);
    this._sorted = true;
  }
  return this._array;
};

exports.H = MappingList;


/***/ }),

/***/ 3254:
/***/ ((__unused_webpack_module, exports) => {

/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */

// It turns out that some (most?) JavaScript engines don't self-host
// `Array.prototype.sort`. This makes sense because C++ will likely remain
// faster than JS when doing raw CPU-intensive sorting. However, when using a
// custom comparator function, calling back and forth between the VM's C++ and
// JIT'd JS is rather slow *and* loses JIT type information, resulting in
// worse generated code for the comparator function than would be optimal. In
// fact, when sorting with a comparator, these costs outweigh the benefits of
// sorting in C++. By using our own JS-implemented Quick Sort (below), we get
// a ~3500ms mean speed-up in `bench/bench.html`.

/**
 * Swap the elements indexed by `x` and `y` in the array `ary`.
 *
 * @param {Array} ary
 *        The array.
 * @param {Number} x
 *        The index of the first item.
 * @param {Number} y
 *        The index of the second item.
 */
function swap(ary, x, y) {
  var temp = ary[x];
  ary[x] = ary[y];
  ary[y] = temp;
}

/**
 * Returns a random integer within the range `low .. high` inclusive.
 *
 * @param {Number} low
 *        The lower bound on the range.
 * @param {Number} high
 *        The upper bound on the range.
 */
function randomIntInRange(low, high) {
  return Math.round(low + (Math.random() * (high - low)));
}

/**
 * The Quick Sort algorithm.
 *
 * @param {Array} ary
 *        An array to sort.
 * @param {function} comparator
 *        Function to use to compare two items.
 * @param {Number} p
 *        Start index of the array
 * @param {Number} r
 *        End index of the array
 */
function doQuickSort(ary, comparator, p, r) {
  // If our lower bound is less than our upper bound, we (1) partition the
  // array into two pieces and (2) recurse on each half. If it is not, this is
  // the empty array and our base case.

  if (p < r) {
    // (1) Partitioning.
    //
    // The partitioning chooses a pivot between `p` and `r` and moves all
    // elements that are less than or equal to the pivot to the before it, and
    // all the elements that are greater than it after it. The effect is that
    // once partition is done, the pivot is in the exact place it will be when
    // the array is put in sorted order, and it will not need to be moved
    // again. This runs in O(n) time.

    // Always choose a random pivot so that an input array which is reverse
    // sorted does not cause O(n^2) running time.
    var pivotIndex = randomIntInRange(p, r);
    var i = p - 1;

    swap(ary, pivotIndex, r);
    var pivot = ary[r];

    // Immediately after `j` is incremented in this loop, the following hold
    // true:
    //
    //   * Every element in `ary[p .. i]` is less than or equal to the pivot.
    //
    //   * Every element in `ary[i+1 .. j-1]` is greater than the pivot.
    for (var j = p; j < r; j++) {
      if (comparator(ary[j], pivot) <= 0) {
        i += 1;
        swap(ary, i, j);
      }
    }

    swap(ary, i + 1, j);
    var q = i + 1;

    // (2) Recurse on each half.

    doQuickSort(ary, comparator, p, q - 1);
    doQuickSort(ary, comparator, q + 1, r);
  }
}

/**
 * Sort the given array in-place with the given comparator function.
 *
 * @param {Array} ary
 *        An array to sort.
 * @param {function} comparator
 *        Function to use to compare two items.
 */
exports.U = function (ary, comparator) {
  doQuickSort(ary, comparator, 0, ary.length - 1);
};


/***/ }),

/***/ 5155:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {

var __webpack_unused_export__;
/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */

var util = __nccwpck_require__(2344);
var binarySearch = __nccwpck_require__(3600);
var ArraySet = (__nccwpck_require__(6375)/* .ArraySet */ .I);
var base64VLQ = __nccwpck_require__(975);
var quickSort = (__nccwpck_require__(3254)/* .quickSort */ .U);

function SourceMapConsumer(aSourceMap) {
  var sourceMap = aSourceMap;
  if (typeof aSourceMap === 'string') {
    sourceMap = JSON.parse(aSourceMap.replace(/^\)\]\}'/, ''));
  }

  return sourceMap.sections != null
    ? new IndexedSourceMapConsumer(sourceMap)
    : new BasicSourceMapConsumer(sourceMap);
}

SourceMapConsumer.fromSourceMap = function(aSourceMap) {
  return BasicSourceMapConsumer.fromSourceMap(aSourceMap);
}

/**
 * The version of the source mapping spec that we are consuming.
 */
SourceMapConsumer.prototype._version = 3;

// `__generatedMappings` and `__originalMappings` are arrays that hold the
// parsed mapping coordinates from the source map's "mappings" attribute. They
// are lazily instantiated, accessed via the `_generatedMappings` and
// `_originalMappings` getters respectively, and we only parse the mappings
// and create these arrays once queried for a source location. We jump through
// these hoops because there can be many thousands of mappings, and parsing
// them is expensive, so we only want to do it if we must.
//
// Each object in the arrays is of the form:
//
//     {
//       generatedLine: The line number in the generated code,
//       generatedColumn: The column number in the generated code,
//       source: The path to the original source file that generated this
//               chunk of code,
//       originalLine: The line number in the original source that
//                     corresponds to this chunk of generated code,
//       originalColumn: The column number in the original source that
//                       corresponds to this chunk of generated code,
//       name: The name of the original symbol which generated this chunk of
//             code.
//     }
//
// All properties except for `generatedLine` and `generatedColumn` can be
// `null`.
//
// `_generatedMappings` is ordered by the generated positions.
//
// `_originalMappings` is ordered by the original positions.

SourceMapConsumer.prototype.__generatedMappings = null;
Object.defineProperty(SourceMapConsumer.prototype, '_generatedMappings', {
  get: function () {
    if (!this.__generatedMappings) {
      this._parseMappings(this._mappings, this.sourceRoot);
    }

    return this.__generatedMappings;
  }
});

SourceMapConsumer.prototype.__originalMappings = null;
Object.defineProperty(SourceMapConsumer.prototype, '_originalMappings', {
  get: function () {
    if (!this.__originalMappings) {
      this._parseMappings(this._mappings, this.sourceRoot);
    }

    return this.__originalMappings;
  }
});

SourceMapConsumer.prototype._charIsMappingSeparator =
  function SourceMapConsumer_charIsMappingSeparator(aStr, index) {
    var c = aStr.charAt(index);
    return c === ";" || c === ",";
  };

/**
 * Parse the mappings in a string in to a data structure which we can easily
 * query (the ordered arrays in the `this.__generatedMappings` and
 * `this.__originalMappings` properties).
 */
SourceMapConsumer.prototype._parseMappings =
  function SourceMapConsumer_parseMappings(aStr, aSourceRoot) {
    throw new Error("Subclasses must implement _parseMappings");
  };

SourceMapConsumer.GENERATED_ORDER = 1;
SourceMapConsumer.ORIGINAL_ORDER = 2;

SourceMapConsumer.GREATEST_LOWER_BOUND = 1;
SourceMapConsumer.LEAST_UPPER_BOUND = 2;

/**
 * Iterate over each mapping between an original source/line/column and a
 * generated line/column in this source map.
 *
 * @param Function aCallback
 *        The function that is called with each mapping.
 * @param Object aContext
 *        Optional. If specified, this object will be the value of `this` every
 *        time that `aCallback` is called.
 * @param aOrder
 *        Either `SourceMapConsumer.GENERATED_ORDER` or
 *        `SourceMapConsumer.ORIGINAL_ORDER`. Specifies whether you want to
 *        iterate over the mappings sorted by the generated file's line/column
 *        order or the original's source/line/column order, respectively. Defaults to
 *        `SourceMapConsumer.GENERATED_ORDER`.
 */
SourceMapConsumer.prototype.eachMapping =
  function SourceMapConsumer_eachMapping(aCallback, aContext, aOrder) {
    var context = aContext || null;
    var order = aOrder || SourceMapConsumer.GENERATED_ORDER;

    var mappings;
    switch (order) {
    case SourceMapConsumer.GENERATED_ORDER:
      mappings = this._generatedMappings;
      break;
    case SourceMapConsumer.ORIGINAL_ORDER:
      mappings = this._originalMappings;
      break;
    default:
      throw new Error("Unknown order of iteration.");
    }

    var sourceRoot = this.sourceRoot;
    mappings.map(function (mapping) {
      var source = mapping.source === null ? null : this._sources.at(mapping.source);
      if (source != null && sourceRoot != null) {
        source = util.join(sourceRoot, source);
      }
      return {
        source: source,
        generatedLine: mapping.generatedLine,
        generatedColumn: mapping.generatedColumn,
        originalLine: mapping.originalLine,
        originalColumn: mapping.originalColumn,
        name: mapping.name === null ? null : this._names.at(mapping.name)
      };
    }, this).forEach(aCallback, context);
  };

/**
 * Returns all generated line and column information for the original source,
 * line, and column provided. If no column is provided, returns all mappings
 * corresponding to a either the line we are searching for or the next
 * closest line that has any mappings. Otherwise, returns all mappings
 * corresponding to the given line and either the column we are searching for
 * or the next closest column that has any offsets.
 *
 * The only argument is an object with the following properties:
 *
 *   - source: The filename of the original source.
 *   - line: The line number in the original source.
 *   - column: Optional. the column number in the original source.
 *
 * and an array of objects is returned, each with the following properties:
 *
 *   - line: The line number in the generated source, or null.
 *   - column: The column number in the generated source, or null.
 */
SourceMapConsumer.prototype.allGeneratedPositionsFor =
  function SourceMapConsumer_allGeneratedPositionsFor(aArgs) {
    var line = util.getArg(aArgs, 'line');

    // When there is no exact match, BasicSourceMapConsumer.prototype._findMapping
    // returns the index of the closest mapping less than the needle. By
    // setting needle.originalColumn to 0, we thus find the last mapping for
    // the given line, provided such a mapping exists.
    var needle = {
      source: util.getArg(aArgs, 'source'),
      originalLine: line,
      originalColumn: util.getArg(aArgs, 'column', 0)
    };

    if (this.sourceRoot != null) {
      needle.source = util.relative(this.sourceRoot, needle.source);
    }
    if (!this._sources.has(needle.source)) {
      return [];
    }
    needle.source = this._sources.indexOf(needle.source);

    var mappings = [];

    var index = this._findMapping(needle,
                                  this._originalMappings,
                                  "originalLine",
                                  "originalColumn",
                                  util.compareByOriginalPositions,
                                  binarySearch.LEAST_UPPER_BOUND);
    if (index >= 0) {
      var mapping = this._originalMappings[index];

      if (aArgs.column === undefined) {
        var originalLine = mapping.originalLine;

        // Iterate until either we run out of mappings, or we run into
        // a mapping for a different line than the one we found. Since
        // mappings are sorted, this is guaranteed to find all mappings for
        // the line we found.
        while (mapping && mapping.originalLine === originalLine) {
          mappings.push({
            line: util.getArg(mapping, 'generatedLine', null),
            column: util.getArg(mapping, 'generatedColumn', null),
            lastColumn: util.getArg(mapping, 'lastGeneratedColumn', null)
          });

          mapping = this._originalMappings[++index];
        }
      } else {
        var originalColumn = mapping.originalColumn;

        // Iterate until either we run out of mappings, or we run into
        // a mapping for a different line than the one we were searching for.
        // Since mappings are sorted, this is guaranteed to find all mappings for
        // the line we are searching for.
        while (mapping &&
               mapping.originalLine === line &&
               mapping.originalColumn == originalColumn) {
          mappings.push({
            line: util.getArg(mapping, 'generatedLine', null),
            column: util.getArg(mapping, 'generatedColumn', null),
            lastColumn: util.getArg(mapping, 'lastGeneratedColumn', null)
          });

          mapping = this._originalMappings[++index];
        }
      }
    }

    return mappings;
  };

exports.SourceMapConsumer = SourceMapConsumer;

/**
 * A BasicSourceMapConsumer instance represents a parsed source map which we can
 * query for information about the original file positions by giving it a file
 * position in the generated source.
 *
 * The only parameter is the raw source map (either as a JSON string, or
 * already parsed to an object). According to the spec, source maps have the
 * following attributes:
 *
 *   - version: Which version of the source map spec this map is following.
 *   - sources: An array of URLs to the original source files.
 *   - names: An array of identifiers which can be referrenced by individual mappings.
 *   - sourceRoot: Optional. The URL root from which all sources are relative.
 *   - sourcesContent: Optional. An array of contents of the original source files.
 *   - mappings: A string of base64 VLQs which contain the actual mappings.
 *   - file: Optional. The generated file this source map is associated with.
 *
 * Here is an example source map, taken from the source map spec[0]:
 *
 *     {
 *       version : 3,
 *       file: "out.js",
 *       sourceRoot : "",
 *       sources: ["foo.js", "bar.js"],
 *       names: ["src", "maps", "are", "fun"],
 *       mappings: "AA,AB;;ABCDE;"
 *     }
 *
 * [0]: https://docs.google.com/document/d/1U1RGAehQwRypUTovF1KRlpiOFze0b-_2gc6fAH0KY0k/edit?pli=1#
 */
function BasicSourceMapConsumer(aSourceMap) {
  var sourceMap = aSourceMap;
  if (typeof aSourceMap === 'string') {
    sourceMap = JSON.parse(aSourceMap.replace(/^\)\]\}'/, ''));
  }

  var version = util.getArg(sourceMap, 'version');
  var sources = util.getArg(sourceMap, 'sources');
  // Sass 3.3 leaves out the 'names' array, so we deviate from the spec (which
  // requires the array) to play nice here.
  var names = util.getArg(sourceMap, 'names', []);
  var sourceRoot = util.getArg(sourceMap, 'sourceRoot', null);
  var sourcesContent = util.getArg(sourceMap, 'sourcesContent', null);
  var mappings = util.getArg(sourceMap, 'mappings');
  var file = util.getArg(sourceMap, 'file', null);

  // Once again, Sass deviates from the spec and supplies the version as a
  // string rather than a number, so we use loose equality checking here.
  if (version != this._version) {
    throw new Error('Unsupported version: ' + version);
  }

  sources = sources
    .map(String)
    // Some source maps produce relative source paths like "./foo.js" instead of
    // "foo.js".  Normalize these first so that future comparisons will succeed.
    // See bugzil.la/1090768.
    .map(util.normalize)
    // Always ensure that absolute sources are internally stored relative to
    // the source root, if the source root is absolute. Not doing this would
    // be particularly problematic when the source root is a prefix of the
    // source (valid, but why??). See github issue #199 and bugzil.la/1188982.
    .map(function (source) {
      return sourceRoot && util.isAbsolute(sourceRoot) && util.isAbsolute(source)
        ? util.relative(sourceRoot, source)
        : source;
    });

  // Pass `true` below to allow duplicate names and sources. While source maps
  // are intended to be compressed and deduplicated, the TypeScript compiler
  // sometimes generates source maps with duplicates in them. See Github issue
  // #72 and bugzil.la/889492.
  this._names = ArraySet.fromArray(names.map(String), true);
  this._sources = ArraySet.fromArray(sources, true);

  this.sourceRoot = sourceRoot;
  this.sourcesContent = sourcesContent;
  this._mappings = mappings;
  this.file = file;
}

BasicSourceMapConsumer.prototype = Object.create(SourceMapConsumer.prototype);
BasicSourceMapConsumer.prototype.consumer = SourceMapConsumer;

/**
 * Create a BasicSourceMapConsumer from a SourceMapGenerator.
 *
 * @param SourceMapGenerator aSourceMap
 *        The source map that will be consumed.
 * @returns BasicSourceMapConsumer
 */
BasicSourceMapConsumer.fromSourceMap =
  function SourceMapConsumer_fromSourceMap(aSourceMap) {
    var smc = Object.create(BasicSourceMapConsumer.prototype);

    var names = smc._names = ArraySet.fromArray(aSourceMap._names.toArray(), true);
    var sources = smc._sources = ArraySet.fromArray(aSourceMap._sources.toArray(), true);
    smc.sourceRoot = aSourceMap._sourceRoot;
    smc.sourcesContent = aSourceMap._generateSourcesContent(smc._sources.toArray(),
                                                            smc.sourceRoot);
    smc.file = aSourceMap._file;

    // Because we are modifying the entries (by converting string sources and
    // names to indices into the sources and names ArraySets), we have to make
    // a copy of the entry or else bad things happen. Shared mutable state
    // strikes again! See github issue #191.

    var generatedMappings = aSourceMap._mappings.toArray().slice();
    var destGeneratedMappings = smc.__generatedMappings = [];
    var destOriginalMappings = smc.__originalMappings = [];

    for (var i = 0, length = generatedMappings.length; i < length; i++) {
      var srcMapping = generatedMappings[i];
      var destMapping = new Mapping;
      destMapping.generatedLine = srcMapping.generatedLine;
      destMapping.generatedColumn = srcMapping.generatedColumn;

      if (srcMapping.source) {
        destMapping.source = sources.indexOf(srcMapping.source);
        destMapping.originalLine = srcMapping.originalLine;
        destMapping.originalColumn = srcMapping.originalColumn;

        if (srcMapping.name) {
          destMapping.name = names.indexOf(srcMapping.name);
        }

        destOriginalMappings.push(destMapping);
      }

      destGeneratedMappings.push(destMapping);
    }

    quickSort(smc.__originalMappings, util.compareByOriginalPositions);

    return smc;
  };

/**
 * The version of the source mapping spec that we are consuming.
 */
BasicSourceMapConsumer.prototype._version = 3;

/**
 * The list of original sources.
 */
Object.defineProperty(BasicSourceMapConsumer.prototype, 'sources', {
  get: function () {
    return this._sources.toArray().map(function (s) {
      return this.sourceRoot != null ? util.join(this.sourceRoot, s) : s;
    }, this);
  }
});

/**
 * Provide the JIT with a nice shape / hidden class.
 */
function Mapping() {
  this.generatedLine = 0;
  this.generatedColumn = 0;
  this.source = null;
  this.originalLine = null;
  this.originalColumn = null;
  this.name = null;
}

/**
 * Parse the mappings in a string in to a data structure which we can easily
 * query (the ordered arrays in the `this.__generatedMappings` and
 * `this.__originalMappings` properties).
 */
BasicSourceMapConsumer.prototype._parseMappings =
  function SourceMapConsumer_parseMappings(aStr, aSourceRoot) {
    var generatedLine = 1;
    var previousGeneratedColumn = 0;
    var previousOriginalLine = 0;
    var previousOriginalColumn = 0;
    var previousSource = 0;
    var previousName = 0;
    var length = aStr.length;
    var index = 0;
    var cachedSegments = {};
    var temp = {};
    var originalMappings = [];
    var generatedMappings = [];
    var mapping, str, segment, end, value;

    while (index < length) {
      if (aStr.charAt(index) === ';') {
        generatedLine++;
        index++;
        previousGeneratedColumn = 0;
      }
      else if (aStr.charAt(index) === ',') {
        index++;
      }
      else {
        mapping = new Mapping();
        mapping.generatedLine = generatedLine;

        // Because each offset is encoded relative to the previous one,
        // many segments often have the same encoding. We can exploit this
        // fact by caching the parsed variable length fields of each segment,
        // allowing us to avoid a second parse if we encounter the same
        // segment again.
        for (end = index; end < length; end++) {
          if (this._charIsMappingSeparator(aStr, end)) {
            break;
          }
        }
        str = aStr.slice(index, end);

        segment = cachedSegments[str];
        if (segment) {
          index += str.length;
        } else {
          segment = [];
          while (index < end) {
            base64VLQ.decode(aStr, index, temp);
            value = temp.value;
            index = temp.rest;
            segment.push(value);
          }

          if (segment.length === 2) {
            throw new Error('Found a source, but no line and column');
          }

          if (segment.length === 3) {
            throw new Error('Found a source and line, but no column');
          }

          cachedSegments[str] = segment;
        }

        // Generated column.
        mapping.generatedColumn = previousGeneratedColumn + segment[0];
        previousGeneratedColumn = mapping.generatedColumn;

        if (segment.length > 1) {
          // Original source.
          mapping.source = previousSource + segment[1];
          previousSource += segment[1];

          // Original line.
          mapping.originalLine = previousOriginalLine + segment[2];
          previousOriginalLine = mapping.originalLine;
          // Lines are stored 0-based
          mapping.originalLine += 1;

          // Original column.
          mapping.originalColumn = previousOriginalColumn + segment[3];
          previousOriginalColumn = mapping.originalColumn;

          if (segment.length > 4) {
            // Original name.
            mapping.name = previousName + segment[4];
            previousName += segment[4];
          }
        }

        generatedMappings.push(mapping);
        if (typeof mapping.originalLine === 'number') {
          originalMappings.push(mapping);
        }
      }
    }

    quickSort(generatedMappings, util.compareByGeneratedPositionsDeflated);
    this.__generatedMappings = generatedMappings;

    quickSort(originalMappings, util.compareByOriginalPositions);
    this.__originalMappings = originalMappings;
  };

/**
 * Find the mapping that best matches the hypothetical "needle" mapping that
 * we are searching for in the given "haystack" of mappings.
 */
BasicSourceMapConsumer.prototype._findMapping =
  function SourceMapConsumer_findMapping(aNeedle, aMappings, aLineName,
                                         aColumnName, aComparator, aBias) {
    // To return the position we are searching for, we must first find the
    // mapping for the given position and then return the opposite position it
    // points to. Because the mappings are sorted, we can use binary search to
    // find the best mapping.

    if (aNeedle[aLineName] <= 0) {
      throw new TypeError('Line must be greater than or equal to 1, got '
                          + aNeedle[aLineName]);
    }
    if (aNeedle[aColumnName] < 0) {
      throw new TypeError('Column must be greater than or equal to 0, got '
                          + aNeedle[aColumnName]);
    }

    return binarySearch.search(aNeedle, aMappings, aComparator, aBias);
  };

/**
 * Compute the last column for each generated mapping. The last column is
 * inclusive.
 */
BasicSourceMapConsumer.prototype.computeColumnSpans =
  function SourceMapConsumer_computeColumnSpans() {
    for (var index = 0; index < this._generatedMappings.length; ++index) {
      var mapping = this._generatedMappings[index];

      // Mappings do not contain a field for the last generated columnt. We
      // can come up with an optimistic estimate, however, by assuming that
      // mappings are contiguous (i.e. given two consecutive mappings, the
      // first mapping ends where the second one starts).
      if (index + 1 < this._generatedMappings.length) {
        var nextMapping = this._generatedMappings[index + 1];

        if (mapping.generatedLine === nextMapping.generatedLine) {
          mapping.lastGeneratedColumn = nextMapping.generatedColumn - 1;
          continue;
        }
      }

      // The last mapping for each line spans the entire line.
      mapping.lastGeneratedColumn = Infinity;
    }
  };

/**
 * Returns the original source, line, and column information for the generated
 * source's line and column positions provided. The only argument is an object
 * with the following properties:
 *
 *   - line: The line number in the generated source.
 *   - column: The column number in the generated source.
 *   - bias: Either 'SourceMapConsumer.GREATEST_LOWER_BOUND' or
 *     'SourceMapConsumer.LEAST_UPPER_BOUND'. Specifies whether to return the
 *     closest element that is smaller than or greater than the one we are
 *     searching for, respectively, if the exact element cannot be found.
 *     Defaults to 'SourceMapConsumer.GREATEST_LOWER_BOUND'.
 *
 * and an object is returned with the following properties:
 *
 *   - source: The original source file, or null.
 *   - line: The line number in the original source, or null.
 *   - column: The column number in the original source, or null.
 *   - name: The original identifier, or null.
 */
BasicSourceMapConsumer.prototype.originalPositionFor =
  function SourceMapConsumer_originalPositionFor(aArgs) {
    var needle = {
      generatedLine: util.getArg(aArgs, 'line'),
      generatedColumn: util.getArg(aArgs, 'column')
    };

    var index = this._findMapping(
      needle,
      this._generatedMappings,
      "generatedLine",
      "generatedColumn",
      util.compareByGeneratedPositionsDeflated,
      util.getArg(aArgs, 'bias', SourceMapConsumer.GREATEST_LOWER_BOUND)
    );

    if (index >= 0) {
      var mapping = this._generatedMappings[index];

      if (mapping.generatedLine === needle.generatedLine) {
        var source = util.getArg(mapping, 'source', null);
        if (source !== null) {
          source = this._sources.at(source);
          if (this.sourceRoot != null) {
            source = util.join(this.sourceRoot, source);
          }
        }
        var name = util.getArg(mapping, 'name', null);
        if (name !== null) {
          name = this._names.at(name);
        }
        return {
          source: source,
          line: util.getArg(mapping, 'originalLine', null),
          column: util.getArg(mapping, 'originalColumn', null),
          name: name
        };
      }
    }

    return {
      source: null,
      line: null,
      column: null,
      name: null
    };
  };

/**
 * Return true if we have the source content for every source in the source
 * map, false otherwise.
 */
BasicSourceMapConsumer.prototype.hasContentsOfAllSources =
  function BasicSourceMapConsumer_hasContentsOfAllSources() {
    if (!this.sourcesContent) {
      return false;
    }
    return this.sourcesContent.length >= this._sources.size() &&
      !this.sourcesContent.some(function (sc) { return sc == null; });
  };

/**
 * Returns the original source content. The only argument is the url of the
 * original source file. Returns null if no original source content is
 * available.
 */
BasicSourceMapConsumer.prototype.sourceContentFor =
  function SourceMapConsumer_sourceContentFor(aSource, nullOnMissing) {
    if (!this.sourcesContent) {
      return null;
    }

    if (this.sourceRoot != null) {
      aSource = util.relative(this.sourceRoot, aSource);
    }

    if (this._sources.has(aSource)) {
      return this.sourcesContent[this._sources.indexOf(aSource)];
    }

    var url;
    if (this.sourceRoot != null
        && (url = util.urlParse(this.sourceRoot))) {
      // XXX: file:// URIs and absolute paths lead to unexpected behavior for
      // many users. We can help them out when they expect file:// URIs to
      // behave like it would if they were running a local HTTP server. See
      // https://bugzilla.mozilla.org/show_bug.cgi?id=885597.
      var fileUriAbsPath = aSource.replace(/^file:\/\//, "");
      if (url.scheme == "file"
          && this._sources.has(fileUriAbsPath)) {
        return this.sourcesContent[this._sources.indexOf(fileUriAbsPath)]
      }

      if ((!url.path || url.path == "/")
          && this._sources.has("/" + aSource)) {
        return this.sourcesContent[this._sources.indexOf("/" + aSource)];
      }
    }

    // This function is used recursively from
    // IndexedSourceMapConsumer.prototype.sourceContentFor. In that case, we
    // don't want to throw if we can't find the source - we just want to
    // return null, so we provide a flag to exit gracefully.
    if (nullOnMissing) {
      return null;
    }
    else {
      throw new Error('"' + aSource + '" is not in the SourceMap.');
    }
  };

/**
 * Returns the generated line and column information for the original source,
 * line, and column positions provided. The only argument is an object with
 * the following properties:
 *
 *   - source: The filename of the original source.
 *   - line: The line number in the original source.
 *   - column: The column number in the original source.
 *   - bias: Either 'SourceMapConsumer.GREATEST_LOWER_BOUND' or
 *     'SourceMapConsumer.LEAST_UPPER_BOUND'. Specifies whether to return the
 *     closest element that is smaller than or greater than the one we are
 *     searching for, respectively, if the exact element cannot be found.
 *     Defaults to 'SourceMapConsumer.GREATEST_LOWER_BOUND'.
 *
 * and an object is returned with the following properties:
 *
 *   - line: The line number in the generated source, or null.
 *   - column: The column number in the generated source, or null.
 */
BasicSourceMapConsumer.prototype.generatedPositionFor =
  function SourceMapConsumer_generatedPositionFor(aArgs) {
    var source = util.getArg(aArgs, 'source');
    if (this.sourceRoot != null) {
      source = util.relative(this.sourceRoot, source);
    }
    if (!this._sources.has(source)) {
      return {
        line: null,
        column: null,
        lastColumn: null
      };
    }
    source = this._sources.indexOf(source);

    var needle = {
      source: source,
      originalLine: util.getArg(aArgs, 'line'),
      originalColumn: util.getArg(aArgs, 'column')
    };

    var index = this._findMapping(
      needle,
      this._originalMappings,
      "originalLine",
      "originalColumn",
      util.compareByOriginalPositions,
      util.getArg(aArgs, 'bias', SourceMapConsumer.GREATEST_LOWER_BOUND)
    );

    if (index >= 0) {
      var mapping = this._originalMappings[index];

      if (mapping.source === needle.source) {
        return {
          line: util.getArg(mapping, 'generatedLine', null),
          column: util.getArg(mapping, 'generatedColumn', null),
          lastColumn: util.getArg(mapping, 'lastGeneratedColumn', null)
        };
      }
    }

    return {
      line: null,
      column: null,
      lastColumn: null
    };
  };

__webpack_unused_export__ = BasicSourceMapConsumer;

/**
 * An IndexedSourceMapConsumer instance represents a parsed source map which
 * we can query for information. It differs from BasicSourceMapConsumer in
 * that it takes "indexed" source maps (i.e. ones with a "sections" field) as
 * input.
 *
 * The only parameter is a raw source map (either as a JSON string, or already
 * parsed to an object). According to the spec for indexed source maps, they
 * have the following attributes:
 *
 *   - version: Which version of the source map spec this map is following.
 *   - file: Optional. The generated file this source map is associated with.
 *   - sections: A list of section definitions.
 *
 * Each value under the "sections" field has two fields:
 *   - offset: The offset into the original specified at which this section
 *       begins to apply, defined as an object with a "line" and "column"
 *       field.
 *   - map: A source map definition. This source map could also be indexed,
 *       but doesn't have to be.
 *
 * Instead of the "map" field, it's also possible to have a "url" field
 * specifying a URL to retrieve a source map from, but that's currently
 * unsupported.
 *
 * Here's an example source map, taken from the source map spec[0], but
 * modified to omit a section which uses the "url" field.
 *
 *  {
 *    version : 3,
 *    file: "app.js",
 *    sections: [{
 *      offset: {line:100, column:10},
 *      map: {
 *        version : 3,
 *        file: "section.js",
 *        sources: ["foo.js", "bar.js"],
 *        names: ["src", "maps", "are", "fun"],
 *        mappings: "AAAA,E;;ABCDE;"
 *      }
 *    }],
 *  }
 *
 * [0]: https://docs.google.com/document/d/1U1RGAehQwRypUTovF1KRlpiOFze0b-_2gc6fAH0KY0k/edit#heading=h.535es3xeprgt
 */
function IndexedSourceMapConsumer(aSourceMap) {
  var sourceMap = aSourceMap;
  if (typeof aSourceMap === 'string') {
    sourceMap = JSON.parse(aSourceMap.replace(/^\)\]\}'/, ''));
  }

  var version = util.getArg(sourceMap, 'version');
  var sections = util.getArg(sourceMap, 'sections');

  if (version != this._version) {
    throw new Error('Unsupported version: ' + version);
  }

  this._sources = new ArraySet();
  this._names = new ArraySet();

  var lastOffset = {
    line: -1,
    column: 0
  };
  this._sections = sections.map(function (s) {
    if (s.url) {
      // The url field will require support for asynchronicity.
      // See https://github.com/mozilla/source-map/issues/16
      throw new Error('Support for url field in sections not implemented.');
    }
    var offset = util.getArg(s, 'offset');
    var offsetLine = util.getArg(offset, 'line');
    var offsetColumn = util.getArg(offset, 'column');

    if (offsetLine < lastOffset.line ||
        (offsetLine === lastOffset.line && offsetColumn < lastOffset.column)) {
      throw new Error('Section offsets must be ordered and non-overlapping.');
    }
    lastOffset = offset;

    return {
      generatedOffset: {
        // The offset fields are 0-based, but we use 1-based indices when
        // encoding/decoding from VLQ.
        generatedLine: offsetLine + 1,
        generatedColumn: offsetColumn + 1
      },
      consumer: new SourceMapConsumer(util.getArg(s, 'map'))
    }
  });
}

IndexedSourceMapConsumer.prototype = Object.create(SourceMapConsumer.prototype);
IndexedSourceMapConsumer.prototype.constructor = SourceMapConsumer;

/**
 * The version of the source mapping spec that we are consuming.
 */
IndexedSourceMapConsumer.prototype._version = 3;

/**
 * The list of original sources.
 */
Object.defineProperty(IndexedSourceMapConsumer.prototype, 'sources', {
  get: function () {
    var sources = [];
    for (var i = 0; i < this._sections.length; i++) {
      for (var j = 0; j < this._sections[i].consumer.sources.length; j++) {
        sources.push(this._sections[i].consumer.sources[j]);
      }
    }
    return sources;
  }
});

/**
 * Returns the original source, line, and column information for the generated
 * source's line and column positions provided. The only argument is an object
 * with the following properties:
 *
 *   - line: The line number in the generated source.
 *   - column: The column number in the generated source.
 *
 * and an object is returned with the following properties:
 *
 *   - source: The original source file, or null.
 *   - line: The line number in the original source, or null.
 *   - column: The column number in the original source, or null.
 *   - name: The original identifier, or null.
 */
IndexedSourceMapConsumer.prototype.originalPositionFor =
  function IndexedSourceMapConsumer_originalPositionFor(aArgs) {
    var needle = {
      generatedLine: util.getArg(aArgs, 'line'),
      generatedColumn: util.getArg(aArgs, 'column')
    };

    // Find the section containing the generated position we're trying to map
    // to an original position.
    var sectionIndex = binarySearch.search(needle, this._sections,
      function(needle, section) {
        var cmp = needle.generatedLine - section.generatedOffset.generatedLine;
        if (cmp) {
          return cmp;
        }

        return (needle.generatedColumn -
                section.generatedOffset.generatedColumn);
      });
    var section = this._sections[sectionIndex];

    if (!section) {
      return {
        source: null,
        line: null,
        column: null,
        name: null
      };
    }

    return section.consumer.originalPositionFor({
      line: needle.generatedLine -
        (section.generatedOffset.generatedLine - 1),
      column: needle.generatedColumn -
        (section.generatedOffset.generatedLine === needle.generatedLine
         ? section.generatedOffset.generatedColumn - 1
         : 0),
      bias: aArgs.bias
    });
  };

/**
 * Return true if we have the source content for every source in the source
 * map, false otherwise.
 */
IndexedSourceMapConsumer.prototype.hasContentsOfAllSources =
  function IndexedSourceMapConsumer_hasContentsOfAllSources() {
    return this._sections.every(function (s) {
      return s.consumer.hasContentsOfAllSources();
    });
  };

/**
 * Returns the original source content. The only argument is the url of the
 * original source file. Returns null if no original source content is
 * available.
 */
IndexedSourceMapConsumer.prototype.sourceContentFor =
  function IndexedSourceMapConsumer_sourceContentFor(aSource, nullOnMissing) {
    for (var i = 0; i < this._sections.length; i++) {
      var section = this._sections[i];

      var content = section.consumer.sourceContentFor(aSource, true);
      if (content) {
        return content;
      }
    }
    if (nullOnMissing) {
      return null;
    }
    else {
      throw new Error('"' + aSource + '" is not in the SourceMap.');
    }
  };

/**
 * Returns the generated line and column information for the original source,
 * line, and column positions provided. The only argument is an object with
 * the following properties:
 *
 *   - source: The filename of the original source.
 *   - line: The line number in the original source.
 *   - column: The column number in the original source.
 *
 * and an object is returned with the following properties:
 *
 *   - line: The line number in the generated source, or null.
 *   - column: The column number in the generated source, or null.
 */
IndexedSourceMapConsumer.prototype.generatedPositionFor =
  function IndexedSourceMapConsumer_generatedPositionFor(aArgs) {
    for (var i = 0; i < this._sections.length; i++) {
      var section = this._sections[i];

      // Only consider this section if the requested source is in the list of
      // sources of the consumer.
      if (section.consumer.sources.indexOf(util.getArg(aArgs, 'source')) === -1) {
        continue;
      }
      var generatedPosition = section.consumer.generatedPositionFor(aArgs);
      if (generatedPosition) {
        var ret = {
          line: generatedPosition.line +
            (section.generatedOffset.generatedLine - 1),
          column: generatedPosition.column +
            (section.generatedOffset.generatedLine === generatedPosition.line
             ? section.generatedOffset.generatedColumn - 1
             : 0)
        };
        return ret;
      }
    }

    return {
      line: null,
      column: null
    };
  };

/**
 * Parse the mappings in a string in to a data structure which we can easily
 * query (the ordered arrays in the `this.__generatedMappings` and
 * `this.__originalMappings` properties).
 */
IndexedSourceMapConsumer.prototype._parseMappings =
  function IndexedSourceMapConsumer_parseMappings(aStr, aSourceRoot) {
    this.__generatedMappings = [];
    this.__originalMappings = [];
    for (var i = 0; i < this._sections.length; i++) {
      var section = this._sections[i];
      var sectionMappings = section.consumer._generatedMappings;
      for (var j = 0; j < sectionMappings.length; j++) {
        var mapping = sectionMappings[j];

        var source = section.consumer._sources.at(mapping.source);
        if (section.consumer.sourceRoot !== null) {
          source = util.join(section.consumer.sourceRoot, source);
        }
        this._sources.add(source);
        source = this._sources.indexOf(source);

        var name = section.consumer._names.at(mapping.name);
        this._names.add(name);
        name = this._names.indexOf(name);

        // The mappings coming from the consumer for the section have
        // generated positions relative to the start of the section, so we
        // need to offset them to be relative to the start of the concatenated
        // generated file.
        var adjustedMapping = {
          source: source,
          generatedLine: mapping.generatedLine +
            (section.generatedOffset.generatedLine - 1),
          generatedColumn: mapping.generatedColumn +
            (section.generatedOffset.generatedLine === mapping.generatedLine
            ? section.generatedOffset.generatedColumn - 1
            : 0),
          originalLine: mapping.originalLine,
          originalColumn: mapping.originalColumn,
          name: name
        };

        this.__generatedMappings.push(adjustedMapping);
        if (typeof adjustedMapping.originalLine === 'number') {
          this.__originalMappings.push(adjustedMapping);
        }
      }
    }

    quickSort(this.__generatedMappings, util.compareByGeneratedPositionsDeflated);
    quickSort(this.__originalMappings, util.compareByOriginalPositions);
  };

__webpack_unused_export__ = IndexedSourceMapConsumer;


/***/ }),

/***/ 9425:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {

/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */

var base64VLQ = __nccwpck_require__(975);
var util = __nccwpck_require__(2344);
var ArraySet = (__nccwpck_require__(6375)/* .ArraySet */ .I);
var MappingList = (__nccwpck_require__(6817)/* .MappingList */ .H);

/**
 * An instance of the SourceMapGenerator represents a source map which is
 * being built incrementally. You may pass an object with the following
 * properties:
 *
 *   - file: The filename of the generated source.
 *   - sourceRoot: A root for all relative URLs in this source map.
 */
function SourceMapGenerator(aArgs) {
  if (!aArgs) {
    aArgs = {};
  }
  this._file = util.getArg(aArgs, 'file', null);
  this._sourceRoot = util.getArg(aArgs, 'sourceRoot', null);
  this._skipValidation = util.getArg(aArgs, 'skipValidation', false);
  this._sources = new ArraySet();
  this._names = new ArraySet();
  this._mappings = new MappingList();
  this._sourcesContents = null;
}

SourceMapGenerator.prototype._version = 3;

/**
 * Creates a new SourceMapGenerator based on a SourceMapConsumer
 *
 * @param aSourceMapConsumer The SourceMap.
 */
SourceMapGenerator.fromSourceMap =
  function SourceMapGenerator_fromSourceMap(aSourceMapConsumer) {
    var sourceRoot = aSourceMapConsumer.sourceRoot;
    var generator = new SourceMapGenerator({
      file: aSourceMapConsumer.file,
      sourceRoot: sourceRoot
    });
    aSourceMapConsumer.eachMapping(function (mapping) {
      var newMapping = {
        generated: {
          line: mapping.generatedLine,
          column: mapping.generatedColumn
        }
      };

      if (mapping.source != null) {
        newMapping.source = mapping.source;
        if (sourceRoot != null) {
          newMapping.source = util.relative(sourceRoot, newMapping.source);
        }

        newMapping.original = {
          line: mapping.originalLine,
          column: mapping.originalColumn
        };

        if (mapping.name != null) {
          newMapping.name = mapping.name;
        }
      }

      generator.addMapping(newMapping);
    });
    aSourceMapConsumer.sources.forEach(function (sourceFile) {
      var content = aSourceMapConsumer.sourceContentFor(sourceFile);
      if (content != null) {
        generator.setSourceContent(sourceFile, content);
      }
    });
    return generator;
  };

/**
 * Add a single mapping from original source line and column to the generated
 * source's line and column for this source map being created. The mapping
 * object should have the following properties:
 *
 *   - generated: An object with the generated line and column positions.
 *   - original: An object with the original line and column positions.
 *   - source: The original source file (relative to the sourceRoot).
 *   - name: An optional original token name for this mapping.
 */
SourceMapGenerator.prototype.addMapping =
  function SourceMapGenerator_addMapping(aArgs) {
    var generated = util.getArg(aArgs, 'generated');
    var original = util.getArg(aArgs, 'original', null);
    var source = util.getArg(aArgs, 'source', null);
    var name = util.getArg(aArgs, 'name', null);

    if (!this._skipValidation) {
      this._validateMapping(generated, original, source, name);
    }

    if (source != null) {
      source = String(source);
      if (!this._sources.has(source)) {
        this._sources.add(source);
      }
    }

    if (name != null) {
      name = String(name);
      if (!this._names.has(name)) {
        this._names.add(name);
      }
    }

    this._mappings.add({
      generatedLine: generated.line,
      generatedColumn: generated.column,
      originalLine: original != null && original.line,
      originalColumn: original != null && original.column,
      source: source,
      name: name
    });
  };

/**
 * Set the source content for a source file.
 */
SourceMapGenerator.prototype.setSourceContent =
  function SourceMapGenerator_setSourceContent(aSourceFile, aSourceContent) {
    var source = aSourceFile;
    if (this._sourceRoot != null) {
      source = util.relative(this._sourceRoot, source);
    }

    if (aSourceContent != null) {
      // Add the source content to the _sourcesContents map.
      // Create a new _sourcesContents map if the property is null.
      if (!this._sourcesContents) {
        this._sourcesContents = Object.create(null);
      }
      this._sourcesContents[util.toSetString(source)] = aSourceContent;
    } else if (this._sourcesContents) {
      // Remove the source file from the _sourcesContents map.
      // If the _sourcesContents map is empty, set the property to null.
      delete this._sourcesContents[util.toSetString(source)];
      if (Object.keys(this._sourcesContents).length === 0) {
        this._sourcesContents = null;
      }
    }
  };

/**
 * Applies the mappings of a sub-source-map for a specific source file to the
 * source map being generated. Each mapping to the supplied source file is
 * rewritten using the supplied source map. Note: The resolution for the
 * resulting mappings is the minimium of this map and the supplied map.
 *
 * @param aSourceMapConsumer The source map to be applied.
 * @param aSourceFile Optional. The filename of the source file.
 *        If omitted, SourceMapConsumer's file property will be used.
 * @param aSourceMapPath Optional. The dirname of the path to the source map
 *        to be applied. If relative, it is relative to the SourceMapConsumer.
 *        This parameter is needed when the two source maps aren't in the same
 *        directory, and the source map to be applied contains relative source
 *        paths. If so, those relative source paths need to be rewritten
 *        relative to the SourceMapGenerator.
 */
SourceMapGenerator.prototype.applySourceMap =
  function SourceMapGenerator_applySourceMap(aSourceMapConsumer, aSourceFile, aSourceMapPath) {
    var sourceFile = aSourceFile;
    // If aSourceFile is omitted, we will use the file property of the SourceMap
    if (aSourceFile == null) {
      if (aSourceMapConsumer.file == null) {
        throw new Error(
          'SourceMapGenerator.prototype.applySourceMap requires either an explicit source file, ' +
          'or the source map\'s "file" property. Both were omitted.'
        );
      }
      sourceFile = aSourceMapConsumer.file;
    }
    var sourceRoot = this._sourceRoot;
    // Make "sourceFile" relative if an absolute Url is passed.
    if (sourceRoot != null) {
      sourceFile = util.relative(sourceRoot, sourceFile);
    }
    // Applying the SourceMap can add and remove items from the sources and
    // the names array.
    var newSources = new ArraySet();
    var newNames = new ArraySet();

    // Find mappings for the "sourceFile"
    this._mappings.unsortedForEach(function (mapping) {
      if (mapping.source === sourceFile && mapping.originalLine != null) {
        // Check if it can be mapped by the source map, then update the mapping.
        var original = aSourceMapConsumer.originalPositionFor({
          line: mapping.originalLine,
          column: mapping.originalColumn
        });
        if (original.source != null) {
          // Copy mapping
          mapping.source = original.source;
          if (aSourceMapPath != null) {
            mapping.source = util.join(aSourceMapPath, mapping.source)
          }
          if (sourceRoot != null) {
            mapping.source = util.relative(sourceRoot, mapping.source);
          }
          mapping.originalLine = original.line;
          mapping.originalColumn = original.column;
          if (original.name != null) {
            mapping.name = original.name;
          }
        }
      }

      var source = mapping.source;
      if (source != null && !newSources.has(source)) {
        newSources.add(source);
      }

      var name = mapping.name;
      if (name != null && !newNames.has(name)) {
        newNames.add(name);
      }

    }, this);
    this._sources = newSources;
    this._names = newNames;

    // Copy sourcesContents of applied map.
    aSourceMapConsumer.sources.forEach(function (sourceFile) {
      var content = aSourceMapConsumer.sourceContentFor(sourceFile);
      if (content != null) {
        if (aSourceMapPath != null) {
          sourceFile = util.join(aSourceMapPath, sourceFile);
        }
        if (sourceRoot != null) {
          sourceFile = util.relative(sourceRoot, sourceFile);
        }
        this.setSourceContent(sourceFile, content);
      }
    }, this);
  };

/**
 * A mapping can have one of the three levels of data:
 *
 *   1. Just the generated position.
 *   2. The Generated position, original position, and original source.
 *   3. Generated and original position, original source, as well as a name
 *      token.
 *
 * To maintain consistency, we validate that any new mapping being added falls
 * in to one of these categories.
 */
SourceMapGenerator.prototype._validateMapping =
  function SourceMapGenerator_validateMapping(aGenerated, aOriginal, aSource,
                                              aName) {
    // When aOriginal is truthy but has empty values for .line and .column,
    // it is most likely a programmer error. In this case we throw a very
    // specific error message to try to guide them the right way.
    // For example: https://github.com/Polymer/polymer-bundler/pull/519
    if (aOriginal && typeof aOriginal.line !== 'number' && typeof aOriginal.column !== 'number') {
        throw new Error(
            'original.line and original.column are not numbers -- you probably meant to omit ' +
            'the original mapping entirely and only map the generated position. If so, pass ' +
            'null for the original mapping instead of an object with empty or null values.'
        );
    }

    if (aGenerated && 'line' in aGenerated && 'column' in aGenerated
        && aGenerated.line > 0 && aGenerated.column >= 0
        && !aOriginal && !aSource && !aName) {
      // Case 1.
      return;
    }
    else if (aGenerated && 'line' in aGenerated && 'column' in aGenerated
             && aOriginal && 'line' in aOriginal && 'column' in aOriginal
             && aGenerated.line > 0 && aGenerated.column >= 0
             && aOriginal.line > 0 && aOriginal.column >= 0
             && aSource) {
      // Cases 2 and 3.
      return;
    }
    else {
      throw new Error('Invalid mapping: ' + JSON.stringify({
        generated: aGenerated,
        source: aSource,
        original: aOriginal,
        name: aName
      }));
    }
  };

/**
 * Serialize the accumulated mappings in to the stream of base 64 VLQs
 * specified by the source map format.
 */
SourceMapGenerator.prototype._serializeMappings =
  function SourceMapGenerator_serializeMappings() {
    var previousGeneratedColumn = 0;
    var previousGeneratedLine = 1;
    var previousOriginalColumn = 0;
    var previousOriginalLine = 0;
    var previousName = 0;
    var previousSource = 0;
    var result = '';
    var next;
    var mapping;
    var nameIdx;
    var sourceIdx;

    var mappings = this._mappings.toArray();
    for (var i = 0, len = mappings.length; i < len; i++) {
      mapping = mappings[i];
      next = ''

      if (mapping.generatedLine !== previousGeneratedLine) {
        previousGeneratedColumn = 0;
        while (mapping.generatedLine !== previousGeneratedLine) {
          next += ';';
          previousGeneratedLine++;
        }
      }
      else {
        if (i > 0) {
          if (!util.compareByGeneratedPositionsInflated(mapping, mappings[i - 1])) {
            continue;
          }
          next += ',';
        }
      }

      next += base64VLQ.encode(mapping.generatedColumn
                                 - previousGeneratedColumn);
      previousGeneratedColumn = mapping.generatedColumn;

      if (mapping.source != null) {
        sourceIdx = this._sources.indexOf(mapping.source);
        next += base64VLQ.encode(sourceIdx - previousSource);
        previousSource = sourceIdx;

        // lines are stored 0-based in SourceMap spec version 3
        next += base64VLQ.encode(mapping.originalLine - 1
                                   - previousOriginalLine);
        previousOriginalLine = mapping.originalLine - 1;

        next += base64VLQ.encode(mapping.originalColumn
                                   - previousOriginalColumn);
        previousOriginalColumn = mapping.originalColumn;

        if (mapping.name != null) {
          nameIdx = this._names.indexOf(mapping.name);
          next += base64VLQ.encode(nameIdx - previousName);
          previousName = nameIdx;
        }
      }

      result += next;
    }

    return result;
  };

SourceMapGenerator.prototype._generateSourcesContent =
  function SourceMapGenerator_generateSourcesContent(aSources, aSourceRoot) {
    return aSources.map(function (source) {
      if (!this._sourcesContents) {
        return null;
      }
      if (aSourceRoot != null) {
        source = util.relative(aSourceRoot, source);
      }
      var key = util.toSetString(source);
      return Object.prototype.hasOwnProperty.call(this._sourcesContents, key)
        ? this._sourcesContents[key]
        : null;
    }, this);
  };

/**
 * Externalize the source map.
 */
SourceMapGenerator.prototype.toJSON =
  function SourceMapGenerator_toJSON() {
    var map = {
      version: this._version,
      sources: this._sources.toArray(),
      names: this._names.toArray(),
      mappings: this._serializeMappings()
    };
    if (this._file != null) {
      map.file = this._file;
    }
    if (this._sourceRoot != null) {
      map.sourceRoot = this._sourceRoot;
    }
    if (this._sourcesContents) {
      map.sourcesContent = this._generateSourcesContent(map.sources, map.sourceRoot);
    }

    return map;
  };

/**
 * Render the source map being generated to a string.
 */
SourceMapGenerator.prototype.toString =
  function SourceMapGenerator_toString() {
    return JSON.stringify(this.toJSON());
  };

exports.SourceMapGenerator = SourceMapGenerator;


/***/ }),

/***/ 2616:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {

/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */

var SourceMapGenerator = (__nccwpck_require__(9425).SourceMapGenerator);
var util = __nccwpck_require__(2344);

// Matches a Windows-style `\r\n` newline or a `\n` newline used by all other
// operating systems these days (capturing the result).
var REGEX_NEWLINE = /(\r?\n)/;

// Newline character code for charCodeAt() comparisons
var NEWLINE_CODE = 10;

// Private symbol for identifying `SourceNode`s when multiple versions of
// the source-map library are loaded. This MUST NOT CHANGE across
// versions!
var isSourceNode = "$$$isSourceNode$$$";

/**
 * SourceNodes provide a way to abstract over interpolating/concatenating
 * snippets of generated JavaScript source code while maintaining the line and
 * column information associated with the original source code.
 *
 * @param aLine The original line number.
 * @param aColumn The original column number.
 * @param aSource The original source's filename.
 * @param aChunks Optional. An array of strings which are snippets of
 *        generated JS, or other SourceNodes.
 * @param aName The original identifier.
 */
function SourceNode(aLine, aColumn, aSource, aChunks, aName) {
  this.children = [];
  this.sourceContents = {};
  this.line = aLine == null ? null : aLine;
  this.column = aColumn == null ? null : aColumn;
  this.source = aSource == null ? null : aSource;
  this.name = aName == null ? null : aName;
  this[isSourceNode] = true;
  if (aChunks != null) this.add(aChunks);
}

/**
 * Creates a SourceNode from generated code and a SourceMapConsumer.
 *
 * @param aGeneratedCode The generated code
 * @param aSourceMapConsumer The SourceMap for the generated code
 * @param aRelativePath Optional. The path that relative sources in the
 *        SourceMapConsumer should be relative to.
 */
SourceNode.fromStringWithSourceMap =
  function SourceNode_fromStringWithSourceMap(aGeneratedCode, aSourceMapConsumer, aRelativePath) {
    // The SourceNode we want to fill with the generated code
    // and the SourceMap
    var node = new SourceNode();

    // All even indices of this array are one line of the generated code,
    // while all odd indices are the newlines between two adjacent lines
    // (since `REGEX_NEWLINE` captures its match).
    // Processed fragments are accessed by calling `shiftNextLine`.
    var remainingLines = aGeneratedCode.split(REGEX_NEWLINE);
    var remainingLinesIndex = 0;
    var shiftNextLine = function() {
      var lineContents = getNextLine();
      // The last line of a file might not have a newline.
      var newLine = getNextLine() || "";
      return lineContents + newLine;

      function getNextLine() {
        return remainingLinesIndex < remainingLines.length ?
            remainingLines[remainingLinesIndex++] : undefined;
      }
    };

    // We need to remember the position of "remainingLines"
    var lastGeneratedLine = 1, lastGeneratedColumn = 0;

    // The generate SourceNodes we need a code range.
    // To extract it current and last mapping is used.
    // Here we store the last mapping.
    var lastMapping = null;

    aSourceMapConsumer.eachMapping(function (mapping) {
      if (lastMapping !== null) {
        // We add the code from "lastMapping" to "mapping":
        // First check if there is a new line in between.
        if (lastGeneratedLine < mapping.generatedLine) {
          // Associate first line with "lastMapping"
          addMappingWithCode(lastMapping, shiftNextLine());
          lastGeneratedLine++;
          lastGeneratedColumn = 0;
          // The remaining code is added without mapping
        } else {
          // There is no new line in between.
          // Associate the code between "lastGeneratedColumn" and
          // "mapping.generatedColumn" with "lastMapping"
          var nextLine = remainingLines[remainingLinesIndex];
          var code = nextLine.substr(0, mapping.generatedColumn -
                                        lastGeneratedColumn);
          remainingLines[remainingLinesIndex] = nextLine.substr(mapping.generatedColumn -
                                              lastGeneratedColumn);
          lastGeneratedColumn = mapping.generatedColumn;
          addMappingWithCode(lastMapping, code);
          // No more remaining code, continue
          lastMapping = mapping;
          return;
        }
      }
      // We add the generated code until the first mapping
      // to the SourceNode without any mapping.
      // Each line is added as separate string.
      while (lastGeneratedLine < mapping.generatedLine) {
        node.add(shiftNextLine());
        lastGeneratedLine++;
      }
      if (lastGeneratedColumn < mapping.generatedColumn) {
        var nextLine = remainingLines[remainingLinesIndex];
        node.add(nextLine.substr(0, mapping.generatedColumn));
        remainingLines[remainingLinesIndex] = nextLine.substr(mapping.generatedColumn);
        lastGeneratedColumn = mapping.generatedColumn;
      }
      lastMapping = mapping;
    }, this);
    // We have processed all mappings.
    if (remainingLinesIndex < remainingLines.length) {
      if (lastMapping) {
        // Associate the remaining code in the current line with "lastMapping"
        addMappingWithCode(lastMapping, shiftNextLine());
      }
      // and add the remaining lines without any mapping
      node.add(remainingLines.splice(remainingLinesIndex).join(""));
    }

    // Copy sourcesContent into SourceNode
    aSourceMapConsumer.sources.forEach(function (sourceFile) {
      var content = aSourceMapConsumer.sourceContentFor(sourceFile);
      if (content != null) {
        if (aRelativePath != null) {
          sourceFile = util.join(aRelativePath, sourceFile);
        }
        node.setSourceContent(sourceFile, content);
      }
    });

    return node;

    function addMappingWithCode(mapping, code) {
      if (mapping === null || mapping.source === undefined) {
        node.add(code);
      } else {
        var source = aRelativePath
          ? util.join(aRelativePath, mapping.source)
          : mapping.source;
        node.add(new SourceNode(mapping.originalLine,
                                mapping.originalColumn,
                                source,
                                code,
                                mapping.name));
      }
    }
  };

/**
 * Add a chunk of generated JS to this source node.
 *
 * @param aChunk A string snippet of generated JS code, another instance of
 *        SourceNode, or an array where each member is one of those things.
 */
SourceNode.prototype.add = function SourceNode_add(aChunk) {
  if (Array.isArray(aChunk)) {
    aChunk.forEach(function (chunk) {
      this.add(chunk);
    }, this);
  }
  else if (aChunk[isSourceNode] || typeof aChunk === "string") {
    if (aChunk) {
      this.children.push(aChunk);
    }
  }
  else {
    throw new TypeError(
      "Expected a SourceNode, string, or an array of SourceNodes and strings. Got " + aChunk
    );
  }
  return this;
};

/**
 * Add a chunk of generated JS to the beginning of this source node.
 *
 * @param aChunk A string snippet of generated JS code, another instance of
 *        SourceNode, or an array where each member is one of those things.
 */
SourceNode.prototype.prepend = function SourceNode_prepend(aChunk) {
  if (Array.isArray(aChunk)) {
    for (var i = aChunk.length-1; i >= 0; i--) {
      this.prepend(aChunk[i]);
    }
  }
  else if (aChunk[isSourceNode] || typeof aChunk === "string") {
    this.children.unshift(aChunk);
  }
  else {
    throw new TypeError(
      "Expected a SourceNode, string, or an array of SourceNodes and strings. Got " + aChunk
    );
  }
  return this;
};

/**
 * Walk over the tree of JS snippets in this node and its children. The
 * walking function is called once for each snippet of JS and is passed that
 * snippet and the its original associated source's line/column location.
 *
 * @param aFn The traversal function.
 */
SourceNode.prototype.walk = function SourceNode_walk(aFn) {
  var chunk;
  for (var i = 0, len = this.children.length; i < len; i++) {
    chunk = this.children[i];
    if (chunk[isSourceNode]) {
      chunk.walk(aFn);
    }
    else {
      if (chunk !== '') {
        aFn(chunk, { source: this.source,
                     line: this.line,
                     column: this.column,
                     name: this.name });
      }
    }
  }
};

/**
 * Like `String.prototype.join` except for SourceNodes. Inserts `aStr` between
 * each of `this.children`.
 *
 * @param aSep The separator.
 */
SourceNode.prototype.join = function SourceNode_join(aSep) {
  var newChildren;
  var i;
  var len = this.children.length;
  if (len > 0) {
    newChildren = [];
    for (i = 0; i < len-1; i++) {
      newChildren.push(this.children[i]);
      newChildren.push(aSep);
    }
    newChildren.push(this.children[i]);
    this.children = newChildren;
  }
  return this;
};

/**
 * Call String.prototype.replace on the very right-most source snippet. Useful
 * for trimming whitespace from the end of a source node, etc.
 *
 * @param aPattern The pattern to replace.
 * @param aReplacement The thing to replace the pattern with.
 */
SourceNode.prototype.replaceRight = function SourceNode_replaceRight(aPattern, aReplacement) {
  var lastChild = this.children[this.children.length - 1];
  if (lastChild[isSourceNode]) {
    lastChild.replaceRight(aPattern, aReplacement);
  }
  else if (typeof lastChild === 'string') {
    this.children[this.children.length - 1] = lastChild.replace(aPattern, aReplacement);
  }
  else {
    this.children.push(''.replace(aPattern, aReplacement));
  }
  return this;
};

/**
 * Set the source content for a source file. This will be added to the SourceMapGenerator
 * in the sourcesContent field.
 *
 * @param aSourceFile The filename of the source file
 * @param aSourceContent The content of the source file
 */
SourceNode.prototype.setSourceContent =
  function SourceNode_setSourceContent(aSourceFile, aSourceContent) {
    this.sourceContents[util.toSetString(aSourceFile)] = aSourceContent;
  };

/**
 * Walk over the tree of SourceNodes. The walking function is called for each
 * source file content and is passed the filename and source content.
 *
 * @param aFn The traversal function.
 */
SourceNode.prototype.walkSourceContents =
  function SourceNode_walkSourceContents(aFn) {
    for (var i = 0, len = this.children.length; i < len; i++) {
      if (this.children[i][isSourceNode]) {
        this.children[i].walkSourceContents(aFn);
      }
    }

    var sources = Object.keys(this.sourceContents);
    for (var i = 0, len = sources.length; i < len; i++) {
      aFn(util.fromSetString(sources[i]), this.sourceContents[sources[i]]);
    }
  };

/**
 * Return the string representation of this source node. Walks over the tree
 * and concatenates all the various snippets together to one string.
 */
SourceNode.prototype.toString = function SourceNode_toString() {
  var str = "";
  this.walk(function (chunk) {
    str += chunk;
  });
  return str;
};

/**
 * Returns the string representation of this source node along with a source
 * map.
 */
SourceNode.prototype.toStringWithSourceMap = function SourceNode_toStringWithSourceMap(aArgs) {
  var generated = {
    code: "",
    line: 1,
    column: 0
  };
  var map = new SourceMapGenerator(aArgs);
  var sourceMappingActive = false;
  var lastOriginalSource = null;
  var lastOriginalLine = null;
  var lastOriginalColumn = null;
  var lastOriginalName = null;
  this.walk(function (chunk, original) {
    generated.code += chunk;
    if (original.source !== null
        && original.line !== null
        && original.column !== null) {
      if(lastOriginalSource !== original.source
         || lastOriginalLine !== original.line
         || lastOriginalColumn !== original.column
         || lastOriginalName !== original.name) {
        map.addMapping({
          source: original.source,
          original: {
            line: original.line,
            column: original.column
          },
          generated: {
            line: generated.line,
            column: generated.column
          },
          name: original.name
        });
      }
      lastOriginalSource = original.source;
      lastOriginalLine = original.line;
      lastOriginalColumn = original.column;
      lastOriginalName = original.name;
      sourceMappingActive = true;
    } else if (sourceMappingActive) {
      map.addMapping({
        generated: {
          line: generated.line,
          column: generated.column
        }
      });
      lastOriginalSource = null;
      sourceMappingActive = false;
    }
    for (var idx = 0, length = chunk.length; idx < length; idx++) {
      if (chunk.charCodeAt(idx) === NEWLINE_CODE) {
        generated.line++;
        generated.column = 0;
        // Mappings end at eol
        if (idx + 1 === length) {
          lastOriginalSource = null;
          sourceMappingActive = false;
        } else if (sourceMappingActive) {
          map.addMapping({
            source: original.source,
            original: {
              line: original.line,
              column: original.column
            },
            generated: {
              line: generated.line,
              column: generated.column
            },
            name: original.name
          });
        }
      } else {
        generated.column++;
      }
    }
  });
  this.walkSourceContents(function (sourceFile, sourceContent) {
    map.setSourceContent(sourceFile, sourceContent);
  });

  return { code: generated.code, map: map };
};

exports.SourceNode = SourceNode;


/***/ }),

/***/ 2344:
/***/ ((__unused_webpack_module, exports) => {

/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */

/**
 * This is a helper function for getting values from parameter/options
 * objects.
 *
 * @param args The object we are extracting values from
 * @param name The name of the property we are getting.
 * @param defaultValue An optional value to return if the property is missing
 * from the object. If this is not specified and the property is missing, an
 * error will be thrown.
 */
function getArg(aArgs, aName, aDefaultValue) {
  if (aName in aArgs) {
    return aArgs[aName];
  } else if (arguments.length === 3) {
    return aDefaultValue;
  } else {
    throw new Error('"' + aName + '" is a required argument.');
  }
}
exports.getArg = getArg;

var urlRegexp = /^(?:([\w+\-.]+):)?\/\/(?:(\w+:\w+)@)?([\w.]*)(?::(\d+))?(\S*)$/;
var dataUrlRegexp = /^data:.+\,.+$/;

function urlParse(aUrl) {
  var match = aUrl.match(urlRegexp);
  if (!match) {
    return null;
  }
  return {
    scheme: match[1],
    auth: match[2],
    host: match[3],
    port: match[4],
    path: match[5]
  };
}
exports.urlParse = urlParse;

function urlGenerate(aParsedUrl) {
  var url = '';
  if (aParsedUrl.scheme) {
    url += aParsedUrl.scheme + ':';
  }
  url += '//';
  if (aParsedUrl.auth) {
    url += aParsedUrl.auth + '@';
  }
  if (aParsedUrl.host) {
    url += aParsedUrl.host;
  }
  if (aParsedUrl.port) {
    url += ":" + aParsedUrl.port
  }
  if (aParsedUrl.path) {
    url += aParsedUrl.path;
  }
  return url;
}
exports.urlGenerate = urlGenerate;

/**
 * Normalizes a path, or the path portion of a URL:
 *
 * - Replaces consecutive slashes with one slash.
 * - Removes unnecessary '.' parts.
 * - Removes unnecessary '<dir>/..' parts.
 *
 * Based on code in the Node.js 'path' core module.
 *
 * @param aPath The path or url to normalize.
 */
function normalize(aPath) {
  var path = aPath;
  var url = urlParse(aPath);
  if (url) {
    if (!url.path) {
      return aPath;
    }
    path = url.path;
  }
  var isAbsolute = exports.isAbsolute(path);

  var parts = path.split(/\/+/);
  for (var part, up = 0, i = parts.length - 1; i >= 0; i--) {
    part = parts[i];
    if (part === '.') {
      parts.splice(i, 1);
    } else if (part === '..') {
      up++;
    } else if (up > 0) {
      if (part === '') {
        // The first part is blank if the path is absolute. Trying to go
        // above the root is a no-op. Therefore we can remove all '..' parts
        // directly after the root.
        parts.splice(i + 1, up);
        up = 0;
      } else {
        parts.splice(i, 2);
        up--;
      }
    }
  }
  path = parts.join('/');

  if (path === '') {
    path = isAbsolute ? '/' : '.';
  }

  if (url) {
    url.path = path;
    return urlGenerate(url);
  }
  return path;
}
exports.normalize = normalize;

/**
 * Joins two paths/URLs.
 *
 * @param aRoot The root path or URL.
 * @param aPath The path or URL to be joined with the root.
 *
 * - If aPath is a URL or a data URI, aPath is returned, unless aPath is a
 *   scheme-relative URL: Then the scheme of aRoot, if any, is prepended
 *   first.
 * - Otherwise aPath is a path. If aRoot is a URL, then its path portion
 *   is updated with the result and aRoot is returned. Otherwise the result
 *   is returned.
 *   - If aPath is absolute, the result is aPath.
 *   - Otherwise the two paths are joined with a slash.
 * - Joining for example 'http://' and 'www.example.com' is also supported.
 */
function join(aRoot, aPath) {
  if (aRoot === "") {
    aRoot = ".";
  }
  if (aPath === "") {
    aPath = ".";
  }
  var aPathUrl = urlParse(aPath);
  var aRootUrl = urlParse(aRoot);
  if (aRootUrl) {
    aRoot = aRootUrl.path || '/';
  }

  // `join(foo, '//www.example.org')`
  if (aPathUrl && !aPathUrl.scheme) {
    if (aRootUrl) {
      aPathUrl.scheme = aRootUrl.scheme;
    }
    return urlGenerate(aPathUrl);
  }

  if (aPathUrl || aPath.match(dataUrlRegexp)) {
    return aPath;
  }

  // `join('http://', 'www.example.com')`
  if (aRootUrl && !aRootUrl.host && !aRootUrl.path) {
    aRootUrl.host = aPath;
    return urlGenerate(aRootUrl);
  }

  var joined = aPath.charAt(0) === '/'
    ? aPath
    : normalize(aRoot.replace(/\/+$/, '') + '/' + aPath);

  if (aRootUrl) {
    aRootUrl.path = joined;
    return urlGenerate(aRootUrl);
  }
  return joined;
}
exports.join = join;

exports.isAbsolute = function (aPath) {
  return aPath.charAt(0) === '/' || !!aPath.match(urlRegexp);
};

/**
 * Make a path relative to a URL or another path.
 *
 * @param aRoot The root path or URL.
 * @param aPath The path or URL to be made relative to aRoot.
 */
function relative(aRoot, aPath) {
  if (aRoot === "") {
    aRoot = ".";
  }

  aRoot = aRoot.replace(/\/$/, '');

  // It is possible for the path to be above the root. In this case, simply
  // checking whether the root is a prefix of the path won't work. Instead, we
  // need to remove components from the root one by one, until either we find
  // a prefix that fits, or we run out of components to remove.
  var level = 0;
  while (aPath.indexOf(aRoot + '/') !== 0) {
    var index = aRoot.lastIndexOf("/");
    if (index < 0) {
      return aPath;
    }

    // If the only part of the root that is left is the scheme (i.e. http://,
    // file:///, etc.), one or more slashes (/), or simply nothing at all, we
    // have exhausted all components, so the path is not relative to the root.
    aRoot = aRoot.slice(0, index);
    if (aRoot.match(/^([^\/]+:\/)?\/*$/)) {
      return aPath;
    }

    ++level;
  }

  // Make sure we add a "../" for each component we removed from the root.
  return Array(level + 1).join("../") + aPath.substr(aRoot.length + 1);
}
exports.relative = relative;

var supportsNullProto = (function () {
  var obj = Object.create(null);
  return !('__proto__' in obj);
}());

function identity (s) {
  return s;
}

/**
 * Because behavior goes wacky when you set `__proto__` on objects, we
 * have to prefix all the strings in our set with an arbitrary character.
 *
 * See https://github.com/mozilla/source-map/pull/31 and
 * https://github.com/mozilla/source-map/issues/30
 *
 * @param String aStr
 */
function toSetString(aStr) {
  if (isProtoString(aStr)) {
    return '$' + aStr;
  }

  return aStr;
}
exports.toSetString = supportsNullProto ? identity : toSetString;

function fromSetString(aStr) {
  if (isProtoString(aStr)) {
    return aStr.slice(1);
  }

  return aStr;
}
exports.fromSetString = supportsNullProto ? identity : fromSetString;

function isProtoString(s) {
  if (!s) {
    return false;
  }

  var length = s.length;

  if (length < 9 /* "__proto__".length */) {
    return false;
  }

  if (s.charCodeAt(length - 1) !== 95  /* '_' */ ||
      s.charCodeAt(length - 2) !== 95  /* '_' */ ||
      s.charCodeAt(length - 3) !== 111 /* 'o' */ ||
      s.charCodeAt(length - 4) !== 116 /* 't' */ ||
      s.charCodeAt(length - 5) !== 111 /* 'o' */ ||
      s.charCodeAt(length - 6) !== 114 /* 'r' */ ||
      s.charCodeAt(length - 7) !== 112 /* 'p' */ ||
      s.charCodeAt(length - 8) !== 95  /* '_' */ ||
      s.charCodeAt(length - 9) !== 95  /* '_' */) {
    return false;
  }

  for (var i = length - 10; i >= 0; i--) {
    if (s.charCodeAt(i) !== 36 /* '$' */) {
      return false;
    }
  }

  return true;
}

/**
 * Comparator between two mappings where the original positions are compared.
 *
 * Optionally pass in `true` as `onlyCompareGenerated` to consider two
 * mappings with the same original source/line/column, but different generated
 * line and column the same. Useful when searching for a mapping with a
 * stubbed out mapping.
 */
function compareByOriginalPositions(mappingA, mappingB, onlyCompareOriginal) {
  var cmp = mappingA.source - mappingB.source;
  if (cmp !== 0) {
    return cmp;
  }

  cmp = mappingA.originalLine - mappingB.originalLine;
  if (cmp !== 0) {
    return cmp;
  }

  cmp = mappingA.originalColumn - mappingB.originalColumn;
  if (cmp !== 0 || onlyCompareOriginal) {
    return cmp;
  }

  cmp = mappingA.generatedColumn - mappingB.generatedColumn;
  if (cmp !== 0) {
    return cmp;
  }

  cmp = mappingA.generatedLine - mappingB.generatedLine;
  if (cmp !== 0) {
    return cmp;
  }

  return mappingA.name - mappingB.name;
}
exports.compareByOriginalPositions = compareByOriginalPositions;

/**
 * Comparator between two mappings with deflated source and name indices where
 * the generated positions are compared.
 *
 * Optionally pass in `true` as `onlyCompareGenerated` to consider two
 * mappings with the same generated line and column, but different
 * source/name/original line and column the same. Useful when searching for a
 * mapping with a stubbed out mapping.
 */
function compareByGeneratedPositionsDeflated(mappingA, mappingB, onlyCompareGenerated) {
  var cmp = mappingA.generatedLine - mappingB.generatedLine;
  if (cmp !== 0) {
    return cmp;
  }

  cmp = mappingA.generatedColumn - mappingB.generatedColumn;
  if (cmp !== 0 || onlyCompareGenerated) {
    return cmp;
  }

  cmp = mappingA.source - mappingB.source;
  if (cmp !== 0) {
    return cmp;
  }

  cmp = mappingA.originalLine - mappingB.originalLine;
  if (cmp !== 0) {
    return cmp;
  }

  cmp = mappingA.originalColumn - mappingB.originalColumn;
  if (cmp !== 0) {
    return cmp;
  }

  return mappingA.name - mappingB.name;
}
exports.compareByGeneratedPositionsDeflated = compareByGeneratedPositionsDeflated;

function strcmp(aStr1, aStr2) {
  if (aStr1 === aStr2) {
    return 0;
  }

  if (aStr1 > aStr2) {
    return 1;
  }

  return -1;
}

/**
 * Comparator between two mappings with inflated source and name strings where
 * the generated positions are compared.
 */
function compareByGeneratedPositionsInflated(mappingA, mappingB) {
  var cmp = mappingA.generatedLine - mappingB.generatedLine;
  if (cmp !== 0) {
    return cmp;
  }

  cmp = mappingA.generatedColumn - mappingB.generatedColumn;
  if (cmp !== 0) {
    return cmp;
  }

  cmp = strcmp(mappingA.source, mappingB.source);
  if (cmp !== 0) {
    return cmp;
  }

  cmp = mappingA.originalLine - mappingB.originalLine;
  if (cmp !== 0) {
    return cmp;
  }

  cmp = mappingA.originalColumn - mappingB.originalColumn;
  if (cmp !== 0) {
    return cmp;
  }

  return strcmp(mappingA.name, mappingB.name);
}
exports.compareByGeneratedPositionsInflated = compareByGeneratedPositionsInflated;


/***/ }),

/***/ 6594:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {

/*
 * Copyright 2009-2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE.txt or:
 * http://opensource.org/licenses/BSD-3-Clause
 */
exports.SourceMapGenerator = __nccwpck_require__(9425).SourceMapGenerator;
exports.SourceMapConsumer = __nccwpck_require__(5155).SourceMapConsumer;
exports.SourceNode = __nccwpck_require__(2616).SourceNode;


/***/ }),

/***/ 4960:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * split-string <https://github.com/jonschlinkert/split-string>
 *
 * Copyright (c) 2015-2017, Jon Schlinkert.
 * Released under the MIT License.
 */



var extend = __nccwpck_require__(2064);

module.exports = function(str, options, fn) {
  if (typeof str !== 'string') {
    throw new TypeError('expected a string');
  }

  if (typeof options === 'function') {
    fn = options;
    options = null;
  }

  // allow separator to be defined as a string
  if (typeof options === 'string') {
    options = { sep: options };
  }

  var opts = extend({sep: '.'}, options);
  var quotes = opts.quotes || ['"', "'", '`'];
  var brackets;

  if (opts.brackets === true) {
    brackets = {
      '<': '>',
      '(': ')',
      '[': ']',
      '{': '}'
    };
  } else if (opts.brackets) {
    brackets = opts.brackets;
  }

  var tokens = [];
  var stack = [];
  var arr = [''];
  var sep = opts.sep;
  var len = str.length;
  var idx = -1;
  var closeIdx;

  function expected() {
    if (brackets && stack.length) {
      return brackets[stack[stack.length - 1]];
    }
  }

  while (++idx < len) {
    var ch = str[idx];
    var next = str[idx + 1];
    var tok = { val: ch, idx: idx, arr: arr, str: str };
    tokens.push(tok);

    if (ch === '\\') {
      tok.val = keepEscaping(opts, str, idx) === true ? (ch + next) : next;
      tok.escaped = true;
      if (typeof fn === 'function') {
        fn(tok);
      }
      arr[arr.length - 1] += tok.val;
      idx++;
      continue;
    }

    if (brackets && brackets[ch]) {
      stack.push(ch);
      var e = expected();
      var i = idx + 1;

      if (str.indexOf(e, i + 1) !== -1) {
        while (stack.length && i < len) {
          var s = str[++i];
          if (s === '\\') {
            s++;
            continue;
          }

          if (quotes.indexOf(s) !== -1) {
            i = getClosingQuote(str, s, i + 1);
            continue;
          }

          e = expected();
          if (stack.length && str.indexOf(e, i + 1) === -1) {
            break;
          }

          if (brackets[s]) {
            stack.push(s);
            continue;
          }

          if (e === s) {
            stack.pop();
          }
        }
      }

      closeIdx = i;
      if (closeIdx === -1) {
        arr[arr.length - 1] += ch;
        continue;
      }

      ch = str.slice(idx, closeIdx + 1);
      tok.val = ch;
      tok.idx = idx = closeIdx;
    }

    if (quotes.indexOf(ch) !== -1) {
      closeIdx = getClosingQuote(str, ch, idx + 1);
      if (closeIdx === -1) {
        arr[arr.length - 1] += ch;
        continue;
      }

      if (keepQuotes(ch, opts) === true) {
        ch = str.slice(idx, closeIdx + 1);
      } else {
        ch = str.slice(idx + 1, closeIdx);
      }

      tok.val = ch;
      tok.idx = idx = closeIdx;
    }

    if (typeof fn === 'function') {
      fn(tok, tokens);
      ch = tok.val;
      idx = tok.idx;
    }

    if (tok.val === sep && tok.split !== false) {
      arr.push('');
      continue;
    }

    arr[arr.length - 1] += tok.val;
  }

  return arr;
};

function getClosingQuote(str, ch, i, brackets) {
  var idx = str.indexOf(ch, i);
  if (str.charAt(idx - 1) === '\\') {
    return getClosingQuote(str, ch, idx + 1);
  }
  return idx;
}

function keepQuotes(ch, opts) {
  if (opts.keepDoubleQuotes === true && ch === '"') return true;
  if (opts.keepSingleQuotes === true && ch === "'") return true;
  return opts.keepQuotes;
}

function keepEscaping(opts, str, idx) {
  if (typeof opts.keepEscaping === 'function') {
    return opts.keepEscaping(str, idx);
  }
  return opts.keepEscaping === true || str[idx + 1] === '\\';
}


/***/ }),

/***/ 2064:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var isExtendable = __nccwpck_require__(5776);
var assignSymbols = __nccwpck_require__(8782);

module.exports = Object.assign || function(obj/*, objects*/) {
  if (obj === null || typeof obj === 'undefined') {
    throw new TypeError('Cannot convert undefined or null to object');
  }
  if (!isObject(obj)) {
    obj = {};
  }
  for (var i = 1; i < arguments.length; i++) {
    var val = arguments[i];
    if (isString(val)) {
      val = toObject(val);
    }
    if (isObject(val)) {
      assign(obj, val);
      assignSymbols(obj, val);
    }
  }
  return obj;
};

function assign(a, b) {
  for (var key in b) {
    if (hasOwn(b, key)) {
      a[key] = b[key];
    }
  }
}

function isString(val) {
  return (val && typeof val === 'string');
}

function toObject(str) {
  var obj = {};
  for (var i in str) {
    obj[i] = str[i];
  }
  return obj;
}

function isObject(val) {
  return (val && typeof val === 'object') || isExtendable(val);
}

/**
 * Returns true if the given `key` is an own property of `obj`.
 */

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isEnum(obj, key) {
  return Object.prototype.propertyIsEnumerable.call(obj, key);
}


/***/ }),

/***/ 5776:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * is-extendable <https://github.com/jonschlinkert/is-extendable>
 *
 * Copyright (c) 2015-2017, Jon Schlinkert.
 * Released under the MIT License.
 */



var isPlainObject = __nccwpck_require__(7810);

module.exports = function isExtendable(val) {
  return isPlainObject(val) || typeof val === 'function' || Array.isArray(val);
};


/***/ }),

/***/ 9480:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * static-extend <https://github.com/jonschlinkert/static-extend>
 *
 * Copyright (c) 2016, Jon Schlinkert.
 * Licensed under the MIT License.
 */



var copy = __nccwpck_require__(2448);
var define = __nccwpck_require__(6967);
var util = __nccwpck_require__(3837);

/**
 * Returns a function for extending the static properties,
 * prototype properties, and descriptors from the `Parent`
 * constructor onto `Child` constructors.
 *
 * ```js
 * var extend = require('static-extend');
 * Parent.extend = extend(Parent);
 *
 * // optionally pass a custom merge function as the second arg
 * Parent.extend = extend(Parent, function(Child) {
 *   Child.prototype.mixin = function(key, val) {
 *     Child.prototype[key] = val;
 *   };
 * });
 *
 * // extend "child" constructors
 * Parent.extend(Child);
 *
 * // optionally define prototype methods as the second arg
 * Parent.extend(Child, {
 *   foo: function() {},
 *   bar: function() {}
 * });
 * ```
 * @param {Function} `Parent` Parent ctor
 * @param {Function} `extendFn` Optional extend function for handling any necessary custom merging. Useful when updating methods that require a specific prototype.
 *   @param {Function} `Child` Child ctor
 *   @param {Object} `proto` Optionally pass additional prototype properties to inherit.
 *   @return {Object}
 * @api public
 */

function extend(Parent, extendFn) {
  if (typeof Parent !== 'function') {
    throw new TypeError('expected Parent to be a function.');
  }

  return function(Ctor, proto) {
    if (typeof Ctor !== 'function') {
      throw new TypeError('expected Ctor to be a function.');
    }

    util.inherits(Ctor, Parent);
    copy(Ctor, Parent);

    // proto can be null or a plain object
    if (typeof proto === 'object') {
      var obj = Object.create(proto);

      for (var k in obj) {
        Ctor.prototype[k] = obj[k];
      }
    }

    // keep a reference to the parent prototype
    define(Ctor.prototype, '_parent_', {
      configurable: true,
      set: function() {},
      get: function() {
        return Parent.prototype;
      }
    });

    if (typeof extendFn === 'function') {
      extendFn(Ctor, Parent);
    }

    Ctor.extend = extend(Ctor, extendFn);
  };
};

/**
 * Expose `extend`
 */

module.exports = extend;


/***/ }),

/***/ 8636:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * to-object-path <https://github.com/jonschlinkert/to-object-path>
 *
 * Copyright (c) 2015, Jon Schlinkert.
 * Licensed under the MIT License.
 */



var typeOf = __nccwpck_require__(6961);

module.exports = function toPath(args) {
  if (typeOf(args) !== 'arguments') {
    args = arguments;
  }
  return filter(args).join('.');
};

function filter(arr) {
  var len = arr.length;
  var idx = -1;
  var res = [];

  while (++idx < len) {
    var ele = arr[idx];
    if (typeOf(ele) === 'arguments' || Array.isArray(ele)) {
      res.push.apply(res, filter(ele));
    } else if (typeof ele === 'string') {
      res.push(ele);
    }
  }
  return res;
}


/***/ }),

/***/ 1861:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * to-regex-range <https://github.com/jonschlinkert/to-regex-range>
 *
 * Copyright (c) 2015, 2017, Jon Schlinkert.
 * Released under the MIT License.
 */



var repeat = __nccwpck_require__(6976);
var isNumber = __nccwpck_require__(5680);
var cache = {};

function toRegexRange(min, max, options) {
  if (isNumber(min) === false) {
    throw new RangeError('toRegexRange: first argument is invalid.');
  }

  if (typeof max === 'undefined' || min === max) {
    return String(min);
  }

  if (isNumber(max) === false) {
    throw new RangeError('toRegexRange: second argument is invalid.');
  }

  options = options || {};
  var relax = String(options.relaxZeros);
  var shorthand = String(options.shorthand);
  var capture = String(options.capture);
  var key = min + ':' + max + '=' + relax + shorthand + capture;
  if (cache.hasOwnProperty(key)) {
    return cache[key].result;
  }

  var a = Math.min(min, max);
  var b = Math.max(min, max);

  if (Math.abs(a - b) === 1) {
    var result = min + '|' + max;
    if (options.capture) {
      return '(' + result + ')';
    }
    return result;
  }

  var isPadded = padding(min) || padding(max);
  var positives = [];
  var negatives = [];

  var tok = {min: min, max: max, a: a, b: b};
  if (isPadded) {
    tok.isPadded = isPadded;
    tok.maxLen = String(tok.max).length;
  }

  if (a < 0) {
    var newMin = b < 0 ? Math.abs(b) : 1;
    var newMax = Math.abs(a);
    negatives = splitToPatterns(newMin, newMax, tok, options);
    a = tok.a = 0;
  }

  if (b >= 0) {
    positives = splitToPatterns(a, b, tok, options);
  }

  tok.negatives = negatives;
  tok.positives = positives;
  tok.result = siftPatterns(negatives, positives, options);

  if (options.capture && (positives.length + negatives.length) > 1) {
    tok.result = '(' + tok.result + ')';
  }

  cache[key] = tok;
  return tok.result;
}

function siftPatterns(neg, pos, options) {
  var onlyNegative = filterPatterns(neg, pos, '-', false, options) || [];
  var onlyPositive = filterPatterns(pos, neg, '', false, options) || [];
  var intersected = filterPatterns(neg, pos, '-?', true, options) || [];
  var subpatterns = onlyNegative.concat(intersected).concat(onlyPositive);
  return subpatterns.join('|');
}

function splitToRanges(min, max) {
  min = Number(min);
  max = Number(max);

  var nines = 1;
  var stops = [max];
  var stop = +countNines(min, nines);

  while (min <= stop && stop <= max) {
    stops = push(stops, stop);
    nines += 1;
    stop = +countNines(min, nines);
  }

  var zeros = 1;
  stop = countZeros(max + 1, zeros) - 1;

  while (min < stop && stop <= max) {
    stops = push(stops, stop);
    zeros += 1;
    stop = countZeros(max + 1, zeros) - 1;
  }

  stops.sort(compare);
  return stops;
}

/**
 * Convert a range to a regex pattern
 * @param {Number} `start`
 * @param {Number} `stop`
 * @return {String}
 */

function rangeToPattern(start, stop, options) {
  if (start === stop) {
    return {pattern: String(start), digits: []};
  }

  var zipped = zip(String(start), String(stop));
  var len = zipped.length, i = -1;

  var pattern = '';
  var digits = 0;

  while (++i < len) {
    var numbers = zipped[i];
    var startDigit = numbers[0];
    var stopDigit = numbers[1];

    if (startDigit === stopDigit) {
      pattern += startDigit;

    } else if (startDigit !== '0' || stopDigit !== '9') {
      pattern += toCharacterClass(startDigit, stopDigit);

    } else {
      digits += 1;
    }
  }

  if (digits) {
    pattern += options.shorthand ? '\\d' : '[0-9]';
  }

  return { pattern: pattern, digits: [digits] };
}

function splitToPatterns(min, max, tok, options) {
  var ranges = splitToRanges(min, max);
  var len = ranges.length;
  var idx = -1;

  var tokens = [];
  var start = min;
  var prev;

  while (++idx < len) {
    var range = ranges[idx];
    var obj = rangeToPattern(start, range, options);
    var zeros = '';

    if (!tok.isPadded && prev && prev.pattern === obj.pattern) {
      if (prev.digits.length > 1) {
        prev.digits.pop();
      }
      prev.digits.push(obj.digits[0]);
      prev.string = prev.pattern + toQuantifier(prev.digits);
      start = range + 1;
      continue;
    }

    if (tok.isPadded) {
      zeros = padZeros(range, tok);
    }

    obj.string = zeros + obj.pattern + toQuantifier(obj.digits);
    tokens.push(obj);
    start = range + 1;
    prev = obj;
  }

  return tokens;
}

function filterPatterns(arr, comparison, prefix, intersection, options) {
  var res = [];

  for (var i = 0; i < arr.length; i++) {
    var tok = arr[i];
    var ele = tok.string;

    if (options.relaxZeros !== false) {
      if (prefix === '-' && ele.charAt(0) === '0') {
        if (ele.charAt(1) === '{') {
          ele = '0*' + ele.replace(/^0\{\d+\}/, '');
        } else {
          ele = '0*' + ele.slice(1);
        }
      }
    }

    if (!intersection && !contains(comparison, 'string', ele)) {
      res.push(prefix + ele);
    }

    if (intersection && contains(comparison, 'string', ele)) {
      res.push(prefix + ele);
    }
  }
  return res;
}

/**
 * Zip strings (`for in` can be used on string characters)
 */

function zip(a, b) {
  var arr = [];
  for (var ch in a) arr.push([a[ch], b[ch]]);
  return arr;
}

function compare(a, b) {
  return a > b ? 1 : b > a ? -1 : 0;
}

function push(arr, ele) {
  if (arr.indexOf(ele) === -1) arr.push(ele);
  return arr;
}

function contains(arr, key, val) {
  for (var i = 0; i < arr.length; i++) {
    if (arr[i][key] === val) {
      return true;
    }
  }
  return false;
}

function countNines(min, len) {
  return String(min).slice(0, -len) + repeat('9', len);
}

function countZeros(integer, zeros) {
  return integer - (integer % Math.pow(10, zeros));
}

function toQuantifier(digits) {
  var start = digits[0];
  var stop = digits[1] ? (',' + digits[1]) : '';
  if (!stop && (!start || start === 1)) {
    return '';
  }
  return '{' + start + stop + '}';
}

function toCharacterClass(a, b) {
  return '[' + a + ((b - a === 1) ? '' : '-') + b + ']';
}

function padding(str) {
  return /^-?(0+)\d/.exec(str);
}

function padZeros(val, tok) {
  if (tok.isPadded) {
    var diff = Math.abs(tok.maxLen - String(val).length);
    switch (diff) {
      case 0:
        return '';
      case 1:
        return '0';
      default: {
        return '0{' + diff + '}';
      }
    }
  }
  return val;
}

/**
 * Expose `toRegexRange`
 */

module.exports = toRegexRange;


/***/ }),

/***/ 6855:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var safe = __nccwpck_require__(5634);
var define = __nccwpck_require__(3162);
var extend = __nccwpck_require__(4964);
var not = __nccwpck_require__(2527);
var MAX_LENGTH = 1024 * 64;

/**
 * Session cache
 */

var cache = {};

/**
 * Create a regular expression from the given `pattern` string.
 *
 * @param {String|RegExp} `pattern` Pattern can be a string or regular expression.
 * @param {Object} `options`
 * @return {RegExp}
 * @api public
 */

module.exports = function(patterns, options) {
  if (!Array.isArray(patterns)) {
    return makeRe(patterns, options);
  }
  return makeRe(patterns.join('|'), options);
};

/**
 * Create a regular expression from the given `pattern` string.
 *
 * @param {String|RegExp} `pattern` Pattern can be a string or regular expression.
 * @param {Object} `options`
 * @return {RegExp}
 * @api public
 */

function makeRe(pattern, options) {
  if (pattern instanceof RegExp) {
    return pattern;
  }

  if (typeof pattern !== 'string') {
    throw new TypeError('expected a string');
  }

  if (pattern.length > MAX_LENGTH) {
    throw new Error('expected pattern to be less than ' + MAX_LENGTH + ' characters');
  }

  var key = pattern;
  // do this before shallow cloning options, it's a lot faster
  if (!options || (options && options.cache !== false)) {
    key = createKey(pattern, options);

    if (cache.hasOwnProperty(key)) {
      return cache[key];
    }
  }

  var opts = extend({}, options);
  if (opts.contains === true) {
    if (opts.negate === true) {
      opts.strictNegate = false;
    } else {
      opts.strict = false;
    }
  }

  if (opts.strict === false) {
    opts.strictOpen = false;
    opts.strictClose = false;
  }

  var open = opts.strictOpen !== false ? '^' : '';
  var close = opts.strictClose !== false ? '$' : '';
  var flags = opts.flags || '';
  var regex;

  if (opts.nocase === true && !/i/.test(flags)) {
    flags += 'i';
  }

  try {
    if (opts.negate || typeof opts.strictNegate === 'boolean') {
      pattern = not.create(pattern, opts);
    }

    var str = open + '(?:' + pattern + ')' + close;
    regex = new RegExp(str, flags);

    if (opts.safe === true && safe(regex) === false) {
      throw new Error('potentially unsafe regular expression: ' + regex.source);
    }

  } catch (err) {
    if (opts.strictErrors === true || opts.safe === true) {
      err.key = key;
      err.pattern = pattern;
      err.originalOptions = options;
      err.createdOptions = opts;
      throw err;
    }

    try {
      regex = new RegExp('^' + pattern.replace(/(\W)/g, '\\$1') + '$');
    } catch (err) {
      regex = /.^/; //<= match nothing
    }
  }

  if (opts.cache !== false) {
    memoize(regex, key, pattern, opts);
  }
  return regex;
}

/**
 * Memoize generated regex. This can result in dramatic speed improvements
 * and simplify debugging by adding options and pattern to the regex. It can be
 * disabled by passing setting `options.cache` to false.
 */

function memoize(regex, key, pattern, options) {
  define(regex, 'cached', true);
  define(regex, 'pattern', pattern);
  define(regex, 'options', options);
  define(regex, 'key', key);
  cache[key] = regex;
}

/**
 * Create the key to use for memoization. The key is generated
 * by iterating over the options and concatenating key-value pairs
 * to the pattern string.
 */

function createKey(pattern, options) {
  if (!options) return pattern;
  var key = pattern;
  for (var prop in options) {
    if (options.hasOwnProperty(prop)) {
      key += ';' + prop + '=' + String(options[prop]);
    }
  }
  return key;
}

/**
 * Expose `makeRe`
 */

module.exports.makeRe = makeRe;


/***/ }),

/***/ 3162:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * define-property <https://github.com/jonschlinkert/define-property>
 *
 * Copyright (c) 2015-2018, Jon Schlinkert.
 * Released under the MIT License.
 */



var isobject = __nccwpck_require__(5509);
var isDescriptor = __nccwpck_require__(567);
var define = (typeof Reflect !== 'undefined' && Reflect.defineProperty)
  ? Reflect.defineProperty
  : Object.defineProperty;

module.exports = function defineProperty(obj, key, val) {
  if (!isobject(obj) && typeof obj !== 'function' && !Array.isArray(obj)) {
    throw new TypeError('expected an object, function, or array');
  }

  if (typeof key !== 'string') {
    throw new TypeError('expected "key" to be a string');
  }

  if (isDescriptor(val)) {
    define(obj, key, val);
    return obj;
  }

  define(obj, key, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: val
  });

  return obj;
};


/***/ }),

/***/ 4964:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var isExtendable = __nccwpck_require__(7489);
var assignSymbols = __nccwpck_require__(8782);

module.exports = Object.assign || function(obj/*, objects*/) {
  if (obj === null || typeof obj === 'undefined') {
    throw new TypeError('Cannot convert undefined or null to object');
  }
  if (!isObject(obj)) {
    obj = {};
  }
  for (var i = 1; i < arguments.length; i++) {
    var val = arguments[i];
    if (isString(val)) {
      val = toObject(val);
    }
    if (isObject(val)) {
      assign(obj, val);
      assignSymbols(obj, val);
    }
  }
  return obj;
};

function assign(a, b) {
  for (var key in b) {
    if (hasOwn(b, key)) {
      a[key] = b[key];
    }
  }
}

function isString(val) {
  return (val && typeof val === 'string');
}

function toObject(str) {
  var obj = {};
  for (var i in str) {
    obj[i] = str[i];
  }
  return obj;
}

function isObject(val) {
  return (val && typeof val === 'object') || isExtendable(val);
}

/**
 * Returns true if the given `key` is an own property of `obj`.
 */

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isEnum(obj, key) {
  return Object.prototype.propertyIsEnumerable.call(obj, key);
}


/***/ }),

/***/ 7489:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * is-extendable <https://github.com/jonschlinkert/is-extendable>
 *
 * Copyright (c) 2015-2017, Jon Schlinkert.
 * Released under the MIT License.
 */



var isPlainObject = __nccwpck_require__(7810);

module.exports = function isExtendable(val) {
  return isPlainObject(val) || typeof val === 'function' || Array.isArray(val);
};


/***/ }),

/***/ 7303:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



var isObject = __nccwpck_require__(429);
var union = __nccwpck_require__(8815);
var get = __nccwpck_require__(9611);
var set = __nccwpck_require__(4269);

module.exports = function unionValue(obj, prop, value) {
  if (!isObject(obj)) {
    throw new TypeError('union-value expects the first argument to be an object.');
  }

  if (typeof prop !== 'string') {
    throw new TypeError('union-value expects `prop` to be a string.');
  }

  var arr = arrayify(get(obj, prop));
  set(obj, prop, union(arr, arrayify(value)));
  return obj;
};

function arrayify(val) {
  if (val === null || typeof val === 'undefined') {
    return [];
  }
  if (Array.isArray(val)) {
    return val;
  }
  return [val];
}


/***/ }),

/***/ 1571:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * unset-value <https://github.com/jonschlinkert/unset-value>
 *
 * Copyright (c) 2015, 2017, Jon Schlinkert.
 * Released under the MIT License.
 */



var isObject = __nccwpck_require__(5509);
var has = __nccwpck_require__(509);

module.exports = function unset(obj, prop) {
  if (!isObject(obj)) {
    throw new TypeError('expected an object.');
  }
  if (obj.hasOwnProperty(prop)) {
    delete obj[prop];
    return true;
  }

  if (has(obj, prop)) {
    var segs = prop.split('.');
    var last = segs.pop();
    while (segs.length && segs[segs.length - 1].slice(-1) === '\\') {
      last = segs.pop().slice(0, -1) + '.' + last;
    }
    while (segs.length) obj = obj[prop = segs.shift()];
    return (delete obj[last]);
  }
  return true;
};


/***/ }),

/***/ 509:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * has-value <https://github.com/jonschlinkert/has-value>
 *
 * Copyright (c) 2014-2016, Jon Schlinkert.
 * Licensed under the MIT License.
 */



var isObject = __nccwpck_require__(8883);
var hasValues = __nccwpck_require__(5757);
var get = __nccwpck_require__(9611);

module.exports = function(obj, prop, noZero) {
  if (isObject(obj)) {
    return hasValues(get(obj, prop), noZero);
  }
  return hasValues(obj, prop);
};


/***/ }),

/***/ 8883:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

/*!
 * isobject <https://github.com/jonschlinkert/isobject>
 *
 * Copyright (c) 2014-2015, Jon Schlinkert.
 * Licensed under the MIT License.
 */



var isArray = __nccwpck_require__(893);

module.exports = function isObject(val) {
  return val != null && typeof val === 'object' && isArray(val) === false;
};


/***/ }),

/***/ 5757:
/***/ ((module) => {

/*!
 * has-values <https://github.com/jonschlinkert/has-values>
 *
 * Copyright (c) 2014-2015, Jon Schlinkert.
 * Licensed under the MIT License.
 */



module.exports = function hasValue(o, noZero) {
  if (o === null || o === undefined) {
    return false;
  }

  if (typeof o === 'boolean') {
    return true;
  }

  if (typeof o === 'number') {
    if (o === 0 && noZero === true) {
      return false;
    }
    return true;
  }

  if (o.length !== undefined) {
    return o.length !== 0;
  }

  for (var key in o) {
    if (o.hasOwnProperty(key)) {
      return true;
    }
  }
  return false;
};


/***/ }),

/***/ 8987:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

// Copyright 2014 Simon Lydell
// X11 (“MIT”) Licensed. (See LICENSE.)

var path = __nccwpck_require__(1017)

"use strict"

function urix(aPath) {
  if (path.sep === "\\") {
    return aPath
      .replace(/\\/g, "/")
      .replace(/^[a-z]:\/?/i, "/")
  }
  return aPath
}

module.exports = urix


/***/ }),

/***/ 9656:
/***/ ((module) => {

/*!
 * use <https://github.com/jonschlinkert/use>
 *
 * Copyright (c) 2015-2017, Jon Schlinkert.
 * Released under the MIT License.
 */



module.exports = function base(app, options) {
  if (!isObject(app) && typeof app !== 'function') {
    throw new TypeError('expected an object or function');
  }

  var opts = isObject(options) ? options : {};
  var prop = typeof opts.prop === 'string' ? opts.prop : 'fns';
  if (!Array.isArray(app[prop])) {
    define(app, prop, []);
  }

  /**
   * Define a plugin function to be passed to use. The only
   * parameter exposed to the plugin is `app`, the object or function.
   * passed to `use(app)`. `app` is also exposed as `this` in plugins.
   *
   * Additionally, **if a plugin returns a function, the function will
   * be pushed onto the `fns` array**, allowing the plugin to be
   * called at a later point by the `run` method.
   *
   * ```js
   * var use = require('use');
   *
   * // define a plugin
   * function foo(app) {
   *   // do stuff
   * }
   *
   * var app = function(){};
   * use(app);
   *
   * // register plugins
   * app.use(foo);
   * app.use(bar);
   * app.use(baz);
   * ```
   * @name .use
   * @param {Function} `fn` plugin function to call
   * @api public
   */

  define(app, 'use', use);

  /**
   * Run all plugins on `fns`. Any plugin that returns a function
   * when called by `use` is pushed onto the `fns` array.
   *
   * ```js
   * var config = {};
   * app.run(config);
   * ```
   * @name .run
   * @param {Object} `value` Object to be modified by plugins.
   * @return {Object} Returns the object passed to `run`
   * @api public
   */

  define(app, 'run', function(val) {
    if (!isObject(val)) return;

    if (!val.use || !val.run) {
      define(val, prop, val[prop] || []);
      define(val, 'use', use);
    }

    if (!val[prop] || val[prop].indexOf(base) === -1) {
      val.use(base);
    }

    var self = this || app;
    var fns = self[prop];
    var len = fns.length;
    var idx = -1;

    while (++idx < len) {
      val.use(fns[idx]);
    }
    return val;
  });

  /**
   * Call plugin `fn`. If a function is returned push it into the
   * `fns` array to be called by the `run` method.
   */

  function use(type, fn, options) {
    var offset = 1;

    if (typeof type === 'string' || Array.isArray(type)) {
      fn = wrap(type, fn);
      offset++;
    } else {
      options = fn;
      fn = type;
    }

    if (typeof fn !== 'function') {
      throw new TypeError('expected a function');
    }

    var self = this || app;
    var fns = self[prop];

    var args = [].slice.call(arguments, offset);
    args.unshift(self);

    if (typeof opts.hook === 'function') {
      opts.hook.apply(self, args);
    }

    var val = fn.apply(self, args);
    if (typeof val === 'function' && fns.indexOf(val) === -1) {
      fns.push(val);
    }
    return self;
  }

  /**
   * Wrap a named plugin function so that it's only called on objects of the
   * given `type`
   *
   * @param {String} `type`
   * @param {Function} `fn` Plugin function
   * @return {Function}
   */

  function wrap(type, fn) {
    return function plugin() {
      return this.type === type ? fn.apply(this, arguments) : plugin;
    };
  }

  return app;
};

function isObject(val) {
  return val && typeof val === 'object' && !Array.isArray(val);
}

function define(obj, key, val) {
  Object.defineProperty(obj, key, {
    configurable: true,
    writable: true,
    value: val
  });
}


/***/ }),

/***/ 2940:
/***/ ((module) => {

// Returns a wrapper function that returns a wrapped callback
// The wrapper function should do some stuff, and return a
// presumably different callback function.
// This makes sure that own properties are retained, so that
// decorations and such are not lost along the way.
module.exports = wrappy
function wrappy (fn, cb) {
  if (fn && cb) return wrappy(fn)(cb)

  if (typeof fn !== 'function')
    throw new TypeError('need wrapper function')

  Object.keys(fn).forEach(function (k) {
    wrapper[k] = fn[k]
  })

  return wrapper

  function wrapper() {
    var args = new Array(arguments.length)
    for (var i = 0; i < args.length; i++) {
      args[i] = arguments[i]
    }
    var ret = fn.apply(this, args)
    var cb = args[args.length-1]
    if (typeof ret === 'function' && ret !== cb) {
      Object.keys(cb).forEach(function (k) {
        ret[k] = cb[k]
      })
    }
    return ret
  }
}


/***/ }),

/***/ 9491:
/***/ ((module) => {

module.exports = __WEBPACK_EXTERNAL_createRequire(import.meta.url)("assert");

/***/ }),

/***/ 1071:
/***/ ((module) => {

module.exports = __WEBPACK_EXTERNAL_createRequire(import.meta.url)("constants");

/***/ }),

/***/ 2361:
/***/ ((module) => {

module.exports = __WEBPACK_EXTERNAL_createRequire(import.meta.url)("events");

/***/ }),

/***/ 7147:
/***/ ((module) => {

module.exports = __WEBPACK_EXTERNAL_createRequire(import.meta.url)("fs");

/***/ }),

/***/ 1808:
/***/ ((module) => {

module.exports = __WEBPACK_EXTERNAL_createRequire(import.meta.url)("net");

/***/ }),

/***/ 2037:
/***/ ((module) => {

module.exports = __WEBPACK_EXTERNAL_createRequire(import.meta.url)("os");

/***/ }),

/***/ 1017:
/***/ ((module) => {

module.exports = __WEBPACK_EXTERNAL_createRequire(import.meta.url)("path");

/***/ }),

/***/ 2781:
/***/ ((module) => {

module.exports = __WEBPACK_EXTERNAL_createRequire(import.meta.url)("stream");

/***/ }),

/***/ 6224:
/***/ ((module) => {

module.exports = __WEBPACK_EXTERNAL_createRequire(import.meta.url)("tty");

/***/ }),

/***/ 7310:
/***/ ((module) => {

module.exports = __WEBPACK_EXTERNAL_createRequire(import.meta.url)("url");

/***/ }),

/***/ 3837:
/***/ ((module) => {

module.exports = __WEBPACK_EXTERNAL_createRequire(import.meta.url)("util");

/***/ })

/******/ });
/************************************************************************/
/******/ // The module cache
/******/ var __webpack_module_cache__ = {};
/******/ 
/******/ // The require function
/******/ function __nccwpck_require__(moduleId) {
/******/ 	// Check if module is in cache
/******/ 	var cachedModule = __webpack_module_cache__[moduleId];
/******/ 	if (cachedModule !== undefined) {
/******/ 		return cachedModule.exports;
/******/ 	}
/******/ 	// Create a new module (and put it into the cache)
/******/ 	var module = __webpack_module_cache__[moduleId] = {
/******/ 		// no module.id needed
/******/ 		// no module.loaded needed
/******/ 		exports: {}
/******/ 	};
/******/ 
/******/ 	// Execute the module function
/******/ 	var threw = true;
/******/ 	try {
/******/ 		__webpack_modules__[moduleId].call(module.exports, module, module.exports, __nccwpck_require__);
/******/ 		threw = false;
/******/ 	} finally {
/******/ 		if(threw) delete __webpack_module_cache__[moduleId];
/******/ 	}
/******/ 
/******/ 	// Return the exports of the module
/******/ 	return module.exports;
/******/ }
/******/ 
/************************************************************************/
/******/ /* webpack/runtime/compat */
/******/ 
/******/ if (typeof __nccwpck_require__ !== 'undefined') __nccwpck_require__.ab = new URL('.', import.meta.url).pathname.slice(import.meta.url.match(/^file:\/\/\/\w:/) ? 1 : 0, -1) + "/";
/******/ 
/************************************************************************/
var __webpack_exports__ = {};
// This entry need to be wrapped in an IIFE because it need to be isolated against other modules in the chunk.
(() => {
/* harmony import */ var path__WEBPACK_IMPORTED_MODULE_0__ = __nccwpck_require__(1017);
/* harmony import */ var fs__WEBPACK_IMPORTED_MODULE_1__ = __nccwpck_require__(7147);
/* harmony import */ var os__WEBPACK_IMPORTED_MODULE_2__ = __nccwpck_require__(2037);
/* harmony import */ var cpy__WEBPACK_IMPORTED_MODULE_3__ = __nccwpck_require__(4070);






const args = process.argv;

const root = path__WEBPACK_IMPORTED_MODULE_0__.resolve(args[2]);

const packageJson = {
  name: "app-name",
  private: true,
  scripts: {
    dev: "next dev",
    build: "next build",
    start: "next start",
    lint: "next lint",
  },
};

const buildPackage = () => {
  if (!fs__WEBPACK_IMPORTED_MODULE_1__.existsSync(root)) {
    fs__WEBPACK_IMPORTED_MODULE_1__.mkdirSync(root);
  }

  fs__WEBPACK_IMPORTED_MODULE_1__.writeFileSync(
    path__WEBPACK_IMPORTED_MODULE_0__.join(root, "package.json"),
    JSON.stringify(packageJson, null, 2) + os__WEBPACK_IMPORTED_MODULE_2__.EOL
  );

  // copyFiles();
};

const copyFiles = async () => {
  await cpy("**", root, {
    parents: true,
    cwd: __nccwpck_require__.ab + "default",
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
};

function run() {
  // console.log("running");
  buildPackage();
}

run();

})();

