const http = require('http');
const http2 = require('spdy');

const Cabin = require('cabin');
const I18N = require('@ladjs/i18n');
const Koa = require('koa');
const StoreIPAddress = require('@ladjs/store-ip-address');
const Timeout = require('koa-better-timeout');
const _ = require('lodash');
const auth = require('koa-basic-auth');
const autoBind = require('auto-bind');
const bodyParser = require('koa-bodyparser');
const boolean = require('boolean');
const compress = require('koa-compress');
const conditional = require('koa-conditional-get');
const cors = require('kcors');
const errorHandler = require('koa-better-error-handler');
const etag = require('koa-etag');
const helmet = require('koa-helmet');
const ip = require('ip');
const json = require('koa-json');
const koa404Handler = require('koa-404-handler');
const koaConnect = require('koa-connect');
const rateLimiter = require('koa-simple-ratelimit');
const removeTrailingSlashes = require('koa-no-trailing-slash');
const requestId = require('express-request-id');
const requestReceived = require('request-received');
const responseTime = require('response-time');
const sharedConfig = require('@ladjs/shared-config');

class API {
  constructor(config) {
    this.config = {
      ...sharedConfig('API'),
      ...config
    };

    const { logger } = this.config;
    const storeIPAddress = new StoreIPAddress({
      logger,
      ...this.config.storeIPAddress
    });
    const cabin = new Cabin({
      logger,
      ...this.config.cabin
    });

    // initialize the app
    const app = new Koa();

    // store the server initialization
    // so that we can gracefully exit
    // later on with `server.close()`
    let server;

    // listen for error and log events emitted by app
    app.on('error', (err, ctx) => ctx.logger.error(err));
    app.on('log', logger.log);

    // check if we've binded _any_ events otherwise
    // bind all normal events and assume we use the default
    // <https://github.com/luin/ioredis#events>
    const client = this.config.redisClient;
    // go through each event listener type for ioredis and check
    // if we've binded any listeners already
    // <https://nodejs.org/api/events.html#events_emitter_listeners_eventname>
    const listeners = [
      'connect',
      'ready',
      'error',
      'close',
      'reconnecting',
      'end',
      '+node',
      '-node',
      'node error'
    ];
    let bindListeners = true;
    for (let i = 0; i < listeners.length; i++) {
      if (client.listeners(listeners[i]).length > 0) {
        bindListeners = false;
        break;
      }
    }

    if (bindListeners) {
      client.on('connect', () =>
        app.emit('log', 'debug', 'redis connection established')
      );
      client.on('ready', () =>
        app.emit('log', 'debug', 'redis connection ready')
      );
      client.on('error', err => app.emit('error', err));
      client.on('close', () =>
        app.emit('log', 'debug', 'redis connection closed')
      );
      client.on('reconnecting', () =>
        app.emit('log', 'debug', 'redis reconnecting')
      );
      client.on('end', () =>
        app.emit('log', 'debug', 'redis connection ended')
      );
    }

    // only trust proxy if enabled
    app.proxy = boolean(process.env.TRUST_PROXY);

    // specify that this is our api (used by error handler)
    app.context.api = true;

    // override koa's undocumented error handler
    // <https://github.com/sindresorhus/eslint-plugin-unicorn/issues/174>
    // eslint-disable-next-line unicorn/prefer-add-event-listener
    app.context.onerror = errorHandler;

    // adds request received hrtime and date symbols to request object
    // (which is used by Cabin internally to add `request.timestamp` to logs
    app.use(requestReceived);

    // adds `X-Response-Time` header to responses
    app.use(koaConnect(responseTime()));

    // adds or re-uses `X-Request-Id` header
    app.use(koaConnect(requestId()));

    // use the cabin middleware (adds request-based logging and helpers)
    app.use(cabin.middleware);

    // compress/gzip
    app.use(compress());

    // setup localization
    if (this.config.i18n) {
      const i18n = this.config.i18n.config
        ? this.config.i18n
        : new I18N({ ...this.config.i18n, logger });
      app.use(i18n.middleware);
    }

    if (this.config.auth) app.use(auth(this.config.auth));

    // rate limiting
    if (this.config.rateLimit)
      app.use(
        rateLimiter({
          ...this.config.rateLimit,
          db: client
        })
      );

    // conditional-get
    app.use(conditional());

    // etag
    app.use(etag());

    // cors
    if (this.config.cors) app.use(cors(this.config.cors));

    // security
    app.use(helmet());

    // remove trailing slashes
    app.use(removeTrailingSlashes());

    // body parser
    app.use(bodyParser());

    // pretty-printed json responses
    app.use(json());

    // 404 handler
    app.use(koa404Handler);

    // passport
    if (this.config.passport) app.use(this.config.passport.initialize());

    // configure timeout
    if (this.config.timeout) {
      const timeout = new Timeout(this.config.timeout);
      app.use(timeout.middleware);
    }

    // store the user's last ip address in the background
    app.use(storeIPAddress.middleware);

    // allow before hooks to get setup
    if (_.isFunction(this.config.hookBeforeRoutes))
      this.config.hookBeforeRoutes(app);

    // mount the app's defined and nested routes
    if (this.config.routes) {
      if (_.isFunction(this.config.routes.routes))
        app.use(this.config.routes.routes());
      else app.use(this.config.routes);
    }

    // start server on either http or https
    if (this.config.protocol === 'https')
      server = http2.createServer(this.config.ssl, app.callback());
    else server = http.createServer(app.callback());

    // expose app and server
    this.app = app;
    this.server = server;

    autoBind(this);
  }

  listen(port, fn) {
    if (_.isFunction(port)) {
      fn = port;
      port = null;
    }

    const { logger } = this.config;
    if (!_.isFunction(fn))
      fn = function() {
        const { port } = this.address();
        logger.info(
          `Lad API server listening on ${port} (LAN: ${ip.address()}:${port})`
        );
      };

    this.server = this.server.listen(port, fn);
    return this.server;
  }

  close(fn) {
    this.server.close(fn);
    return this;
  }
}

module.exports = API;
