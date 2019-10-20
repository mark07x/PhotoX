import express from 'express';
require(`express-async-errors`);

import path from 'path';
import cookieParser from 'cookie-parser';
import logger from 'morgan';
import session from "express-session";
import redis from 'redis';
import index from './routes';
import db from "./db/db";
import {Store} from "express-session";
import {mkdir} from "fs";
import * as util from "util";
import {promisify, types} from "util";
import query from "./db/query";

export default async function create_application() {
    const redisStore = require('connect-redis')(session);
    const multer = require("multer");
    const RedisConfig = require('./db/RedisConfig');

    const app = express();
    app.set('root', path.join(__dirname, '../'));
    const redis_client = redis.createClient(RedisConfig);
    const store : Store = new redisStore({ client: redis_client });
    const session_map : any = new Proxy({}, {
        get(target, index) {
            return promisify(redis_client.get).bind(redis_client)('session_map:' + index.toString());
        },
        set(target, index, value, receiver) {
            if (value === undefined)
                redis_client.del("session_map:" + index.toString());
            else
                redis_client.set('session_map:' + index.toString(), value);
            return true;
        }
    });
    let config : any = {};
    for (let obj of await db(query.config, [])) {
        try {
            config[obj.name] = JSON.parse(obj.value);
        } catch {
            config[obj.name] = null;
        }
    }

    app.set('views', 'views');
    app.set('port', normalizePort(config.port || '3001'));
    function normalizePort(val: string) {
        const port = Number(val);

        if (isNaN(port)) {
            // named pipe
            return val;
        }

        if (port >= 0) {
            // port number
            return port;
        }

        return false;
    }

    app.set('view engine', 'pug');
    app.enable('view cache');
    app.set('env', config.env || "development");

    app.use(logger('dev'));
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use(cookieParser());
    app.use(session({
        secret: config.session_secret,
        cookie: { maxAge: 60 * 1000 * 60 * 12 },
        resave: false,
        store: store,
        saveUninitialized: false,
        destroy_callback: function (session_id) {
            store.get(session_id, (err , session) => {
                if (err) throw err;
                else session_map[session!.id] = undefined;
            });
            return true;
        }
    }));

    app.use(express.static(path.join(app.get('root'), 'public')));

    app.use(async(req, res, next) => {
        config = {};
        for (let obj of await db(query.config, [])) {
            try {
                config[obj.name] = JSON.parse(obj.value);
            } catch {
                config[obj.name] = null;
            }
        }
        res.locals.config = config;
        res.locals.session = req.session;
        if (req.session && req.session.sign)
            res.locals.unreadMeessageLength = (await db(query.countQueryMyUnreadMessage, [req.session.userID, req.session.userID]))[0]['COUNT(*)'];
        res.locals.typeName = new Proxy({}, {
            get(target, index) {
                if (!isNaN(Number(index))) {
                    switch (Number(index)) {
                        case 0: return 'Editor';
                        case 1: return 'Admin';
                        case 2: return 'Super Admin';
                        case 126: return 'Guest Upload Account';
                        case 127: return 'System';
                        default: return 'Unknown';
                    }
                }
            }
        });

        res.locals.url = req.url;
        next();
    });

    app.use(index(session_map, db, multer( { limits: { fileSize: 1e8 } } )));
    await promisify(mkdir)(path.join(app.get('root'), 'uploads')).catch((err) => {
        if (err.code !== "EEXIST") throw err;
    });
    return app;
}