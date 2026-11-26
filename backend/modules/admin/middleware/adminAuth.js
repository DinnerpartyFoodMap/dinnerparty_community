const { hasPermission } = require("../services/adminPermissions");

function requireAdmin(permission, { codedErrors = false } = {}) {
    return function (req, res, next) {
        const reject = (status, code, error) => res.status(status).json(codedErrors ? { error, code } : { error });
        const user = req.user;
        if (!user) return reject(401, 'AUTH_REQUIRED', '未登录或授权已失效');
        if (!user.admin_level) return reject(403, 'ADMIN_FORBIDDEN', '无管理员权限');
        if (!hasPermission(user, permission)) return reject(403, 'ADMIN_FORBIDDEN', '无此操作权限');
        next();
    };
}

module.exports = requireAdmin;
