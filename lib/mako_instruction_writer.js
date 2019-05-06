/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * Receives transformed instructions from a transformer and uploads
 * them to Manta in a location that is known by Mako gc scripts.
 */
var mod_assertplus = require('assert-plus');
var mod_events = require('events');
var mod_fs = require('fs');
var mod_fsm = require('mooremachine');
var mod_mkdirp = require('mkdirp');
var mod_path = require('path');
var mod_util = require('util');
var mod_uuidv4 = require('uuid/v4');
var mod_vasync = require('vasync');

function
MakoInstructionWriter(opts)
{
	var self = this;

	mod_assertplus.object(opts, 'opts');
	mod_assertplus.object(opts.log, 'opts.log');
	mod_assertplus.object(opts.ctx, 'opts.ctx');
	mod_assertplus.object(opts.listener, 'opts.listener');

	self.mw_ctx = opts.ctx;
	self.mw_log = opts.log.child({
		component: 'MakoInstructionWriter'
	});
	self.mw_listener = opts.listener;

	mod_mkdirp(self._get_instr_path_prefix(), function _onMkdir(err) {
		if (err) {
			throw new Error('unable to mkdir ' +
			    self._get_instr_path_prefix() + ': ' +
			    err.message);
		}

		mod_fsm.FSM.call(self, 'running');
	});
}
mod_util.inherits(MakoInstructionWriter, mod_fsm.FSM);


MakoInstructionWriter.prototype._get_tunables_ref = function
_get_tunables_ref()
{
	return (this.mw_ctx.ctx_cfg.tunables);
};


MakoInstructionWriter.prototype._get_instr_path_prefix = function
_get_instr_path_prefix()
{
	return (this._get_tunables_ref().instr_write_path_prefix);
};


MakoInstructionWriter.prototype._get_instance = function
_get_instance()
{
	return (this.mw_ctx.ctx_cfg.instance);
};


MakoInstructionWriter.prototype._get_collector = function
_get_collector()
{
	return (this.mw_ctx.ctx_metrics_manager.collector);
};


MakoInstructionWriter.prototype._get_instruction_path = function
_get_instruction_path(storage_id)
{
	var self = this;
	/*
	 * We maintain naming compatibility with the offline GC process here.
	 * Formerly, Mako instructions were uploaded as objects to the following
	 * path in manta.
	 *
	 * /poseidon/stor/manta_gc/mako/<manta-storage-id>/
	 * 	$NOW-$MARLIN_JOB-X-$UUID-mako-$MANTA_STORAGE_ID
	 *
	 * Where NOW=$(date +%Y-%m-%d-%H-%M-%S), $MARLIN-JOB was the jobId of
	 * the marlin job that processed the database dumps leading to the
	 * creation of those instructions, and UUID was a UUID generated by that
	 * jobs reducer.
	 *
	 * The mako_gc.sh script that processes these instructions does not rely
	 * on the $MARLIN_JOB or $UUID variables, so we are free to embed them
	 * with our own semantics. The closest analogy to the MARLIN_JOB is the
	 * zonename we're executing in. We generate a UUID for each new batch of
	 * instruction we generate.
	 */
	var date = new Date().toISOString().replace(/T|:/, '-').split('.')[0];
	var uuid = mod_uuidv4();
	var instance = self._get_instance();

	var instr_obj = [date, instance, 'X', uuid, 'mako',
		storage_id].join('-');

	return mod_path.join(self._get_instr_path_prefix(), storage_id,
		instr_obj);
};


MakoInstructionWriter.prototype._format_object_lines = function
_format_object_lines(storage_id, lines)
{
	var self = this;

	return (lines.map(function (line) {
		/*
		 * If account or object information is not present, log it.
		 */
		if (!line[0] || !line[1]) {
			self.mw_log.error({line: line},
			    'MakoInstructionWriter: missing information.');
		}

		return (['mako', storage_id].concat(line)).join('\t');
	}).join('\n')).concat('\n');
};


MakoInstructionWriter.prototype._write_file = function
_write_file(opts, callback)
{
	var self = this;

	mod_assertplus.object(opts, 'opts');
	mod_assertplus.string(opts.data, 'opts.data');
	mod_assertplus.string(opts.path, 'opts.path');

	var basename = mod_path.basename(opts.path);
	var dir = mod_path.dirname(opts.path);
	var dir_tmp = dir + '.tmp';
	var path_tmp = mod_path.join(dir_tmp, basename);

	// When writing files, we first create a file in the <dir>.tmp
	// directory and then "rename" it so that it shows up in the
	// spool directory atomically. This way clients that are
	// rsyncing will never see partially written files.
	mod_vasync.pipeline({
		funcs: [
			// We already did a mkdirp on the instr_path_prefix
			// above so we're just creating the mako's subdir and
			// the tmp directory here.
			function _mkMakoDir(_, cb) {
				mod_fs.mkdir(dir, function _onMkdir(e) {
					if (e && e.code === 'EEXIST') {
						self.mw_log.trace({
							dir: dir
						}, 'mkdir: dir already exists');
						cb();
						return;
					}
					// XXX trace
					self.mw_log.info({
						dir: dir,
						err: e
					}, 'fs.mkdir');
					cb(e);
				});
			}, function _mkMakoDirTmp(_, cb) {
				mod_fs.mkdir(dir_tmp, function _onMkdirTmp(e) {
					if (e && e.code === 'EEXIST') {
						self.mw_log.trace({
							dir: dir_tmp
						}, 'mkdir: dir_tmp already ' +
						    'exists');
						cb();
						return;
					}
					// XXX trace
					self.mw_log.info({
						dir: dir_tmp,
						err: e
					}, 'fs.mkdir dir_tmp');
					cb(e);
				});
			}, function _writeFile(_, cb) {
				mod_fs.writeFile(
				    path_tmp,
				    opts.data,
				    {flag: 'wx'},
				    function _onWritten(e) {
					// XXX trace
					self.mw_log.info({
					    err: e,
					    path: path_tmp
					}, 'fs.writeFile');
					cb(e);
				    });
			}, function _renameFile(_, cb) {
				mod_fs.rename(path_tmp, opts.path,
				    function _onRename(e) {
					// XXX trace
					self.mw_log.info({
					    dest: opts.path,
					    err: e,
					    src: path_tmp
					}, 'fs.rename');
					cb(e);
				    });
			}
		]
	}, callback);
};


MakoInstructionWriter.prototype._listen_for_instructions = function
_listen_for_instructions()
{
	var self = this;

	self.on('instruction', function (instruction) {
		var storage_id = instruction.storage_id;

		var keys = [];
		var lines = [];

		instruction.lines.forEach(function (elem) {
			/*
			 * Remove the current storage_id from the list of
			 * makos on which it resides.  Once the array is
			 * empty, we are free to delete this record from the
			 * table.
			 */
			var index = elem.sharks.findIndex(function (shark) {
				return (shark.manta_storage_id ===
				    instruction.storage_id);
			});
			elem.sharks.splice(index, 1);
			keys.push(elem.key);
			lines.push(elem.line);
		});

		var path = self._get_instruction_path(storage_id);
		var data = self._format_object_lines(storage_id, lines);

		// XXX back to debug!
		self.mw_log.info({
			manta_storage_id: storage_id,
			count: lines.length,
			path: path,
			data: data
		}, 'Received instructions to write.');

		self._write_file({
			data: data,
			path: path
		}, function _onFileWritten(err) {
			if (err) {
				self.mw_log.error({
					path: path,
					err: err.message,
					numlines: lines.length
				}, 'Error encountered while uploading Mako ' +
				    'GC instructions to Manta.');
				return;
			}

			// XXX debug
			self.mw_log.info({
				path: path,
				keys: keys,
				storage_id: storage_id
			}, 'Wrote Mako GC instruction object to spool dir.');

			if (self.mw_ctx.ctx_metrics_manager) {
				self._get_collector()
				    .getCollector('gc_mako_instrs_written')
				    .observe(lines.length, {
					manta_storage_id: storage_id
				    });
			}

			var clean = [];

			instruction.lines.forEach(function (line) {
				/*
				 * In the process of serving a record up to the
				 * cleaner for deletion from the table, it must
				 * be the last one of its kind.  That is, it has
				 * been flushed out to all makos to which it
				 * relates and nothing else depends on it.
				 * Removal of a record from the table means that
				 * we do not plan to need it or see it ever
				 * again.  This is why it's important to remove
				 * it from the table after uploading our last
				 * one rather than our first.  Doing otherwise
				 * could have serious consequences if garbage
				 * collection restarted for any reason (planned
				 * or unplanned).  Unflushed records that have
				 * been deleted from the table will never be
				 * found upon restart and would result in the
				 * leak of an object.
				 */
				if (!line.cleaned_state.cleaned &&
					line.sharks.length === 0) {
					line.cleaned_state.cleaned = true;
					clean.push({
						key: line.key,
						storage: line.size,
						sharks: line.sharks
					});
				}
			});

			self.mw_listener.emit('cleanup', clean);

			self.mw_log.debug({
				path: path,
				key: keys
			}, 'Finished writing instruction data.');
		});
	});
};


MakoInstructionWriter.prototype._stop_listening_for_instructions = function
_stop_listening_for_instructions()
{
	var self = this;

	self.removeAllListeners('instruction');
};


MakoInstructionWriter.prototype.state_running = function
state_running(S)
{
	var self = this;

	self._listen_for_instructions();

	S.on(self, 'assertPause', function () {
		self.mw_log.debug('Pausing mako instruction writer');
		S.gotoState('paused');
	});

	S.on(self, 'assertResume', function () {
		self.emit('running');
	});

	S.on(self, 'assertShutdown', function () {
		self._stop_listening_for_instructions();
		S.gotoState('shutdown');
	});

	self.emit('running');
};


MakoInstructionWriter.prototype.state_paused = function
state_paused(S)
{
	var self = this;

	self._stop_listening_for_instructions();

	S.on(self, 'assertResume', function () {
		S.gotoState('running');
	});

	S.on(self, 'assertPause', function () {
		self.emit('paused');
	});

	S.on(self, 'assertShutdown', function () {
		S.gotoState('shutdown');
	});

	self.emit('paused');
};


MakoInstructionWriter.prototype.state_shutdown = function
state_shutdown(S)
{
	var self = this;
	self.emit('shutdown');

	S.on(self, 'assertShutdown', function () {
		self.mw_log.debug('Received shutdown event ' +
			'multiple times!');
	});
};


MakoInstructionWriter.prototype.describe = function
describe()
{
	var self = this;

	var descr = {
		component: 'instruction writer',
		state: self.getState()
	};

	return (descr);
};


module.exports = {

	MakoInstructionWriter: MakoInstructionWriter

};