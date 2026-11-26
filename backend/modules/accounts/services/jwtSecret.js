'use strict';

// JWT 签名密钥。仓库是公开的，代码里的回退值人人都知道，只给测试脚本和本地临时用；
// index.js 启动时调用 assertJwtSecretConfigured()，没配或用的是回退值就拒绝启动。

const DEV_FALLBACK = 'yuyuko_secret_key';
const MIN_LENGTH = 32;

const JWT_SECRET = process.env.JWT_SECRET || DEV_FALLBACK;

/** 返回问题描述；配置可用时返回 null */
function jwtSecretProblem(value = process.env.JWT_SECRET) {
    if (!value) return 'JWT_SECRET is not set';
    if (value === DEV_FALLBACK) return 'JWT_SECRET is the public development fallback';
    if (value.length < MIN_LENGTH) return `JWT_SECRET is shorter than ${MIN_LENGTH} characters`;
    return null;
}

function assertJwtSecretConfigured() {
    const problem = jwtSecretProblem();
    if (problem) {
        const error = new Error(`${problem}; generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`);
        error.code = 'JWT_SECRET_INVALID';
        throw error;
    }
}

module.exports = { JWT_SECRET, DEV_FALLBACK, MIN_LENGTH, jwtSecretProblem, assertJwtSecretConfigured };
