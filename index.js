'use strict';

const bunyan = require('bunyan');
const bunyanDebug = require('bunyan-debug-stream');
const Candle = require('./vendor/candle');
const color = require('color-convert');
const convict = require('convict');
const e131 = require('e131');
const fse = require('fs-extra');
const path = require('path');

const logger = bunyan.createLogger({
	name: 'lighting',
	streams: [{
		level: 'debug',
		type: 'raw',
		stream: bunyanDebug({
			basepath: path.resolve(path.join(__dirname, '..')),
			forceColor: true
		})
	}],
	serializers: bunyanDebug.serializers
});

logger.debug('Initializing');

const SCHEMA = {
	universes: {
		format: Array,
		default: []
	},
	channels: {
		format: Array,
		default: []
	}
};

const schema = convict(SCHEMA);
const config = schema.loadFile('./config.js');
config.validate({allowed:'strict'});

logger.info({config: config.getProperties()}, 'config');

class Universe {
	constructor(u) {
		this._config = u;

		this.name = u.name;
		this.address = u.ip;
		this.channelCount = u.channels;

		this.client = new e131.Client(this.address);
		this.packet = this.client.createPacket(this.channelCount);
		this.data = this.packet.getSlotsData();

		this.packet.setOption(this.packet.Options.PREVIEW, true);
	}

	async send() {
		// for testing
		logger.debug({name: this.name, data:this.data}, 'Sending');
		return Promise.resolve();

		return new Promise((resolve, reject) => {
			this.client.send(this.packet, (err) => {
				if (err) return reject(err);
				resolve();
			});
		});
	}
};

function parseColorToHsv(str) {
	let c = color.keyword.hsv(str);
	if (c) return c;

	if (str.startsWith('rgb')) {
		c = color.rgb.hsv(str);
		if (!c) throw new Error('Unknown color: ' + str);
		return c;
	}

	if (str.startsWith('hsv')) {
		c = color.hsv.hsv(str);
		if (!c) throw new Error('Unknown color: ' + str);
		return c;
	}

	if (str.startsWith('0x')) {
		c = color.hex.hsv(str);
		if (!c) throw new Error('Unkown color: ' + str);
		return c;
	}
}

class Channel {
	constructor(c, u) {
		this._config = c;
		this._universe = u;
	}

	_set(data) {
		for (let i = this._config.channel; i < data.length; ++i) {
			this._universe.data[i] = data[i];
		}
	}

	update() {
		const c = this._config;

		let hsv = parseColorToHsv(c.hue);
		if (c.effect === 'candle') {
			const f = c.candle;
			const value = f.level;

			if (!c._candle) {
				c._candle = new Candle(f);
			}
			c._candle.update();
			const flame = c._candle.flame / 255;

			hsv[2] = (flame * value[1]) + value[0];
		}

		if (c.type === 'hsv') {
			this._set(hsv);
		} else if (c.type === 'rgb') {
			this._set(color.hsv.rgb(hsv));
		} else {
			logger.error('Unhandled color type: ' + c.type);
		}
	}
};

const RATE = 30; // 30hz

// run server
(async () => {
	const universes = config.get('universes').map(u => {
		return new Universe(u);
	});

	const channels = config.get('channels').map(c => {
		const u = universes.find(u => u._config.name === c.universe);
		if (!u) {
			throw new Error('No matching universe');
		}
		return new Channel(c, u);
	});

	logger.info('starting server');

	const repl = require('repl').start();
	const context = repl.context;

	let quit = false;
	context.quit = () => quit = true;

	repl.on('exit', () => quit = true);

	await new Promise((resolve, reject) => {
		const NOMINAL_DELAY = (1/RATE) * 1000; // milliseconds to wait
		const start = Date.now();
		let frame = 0;

		async function loop() {
			if (quit) return resolve();

			++frame;

			await Promise.all(channels.map(c => c.update()));
			await Promise.all(universes.map(u => u.send()));

			const target = start + (NOMINAL_DELAY * frame);
			const now = Date.now();
			const wait = target - now;
			if (wait <= 0) {
				logger.error('frame wait is less than 0');
				wait = 0;
			}
			setTimeout(loop, wait);
		}
		loop();
	});

	process.exit();
})()
.then(() => logger.info('exiting'))
.catch(err => logger.fatal({err}, 'error'));
