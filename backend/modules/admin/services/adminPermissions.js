const PERMISSIONS = {
    YUYUKO: ["manage_users", "manage_bans", "view_audit", "manage_places", "manage_invites", "manage_skin_codes", "manage_comments", "manage_announcements", "manage_feedback"],
    YOUMU: ["manage_users_general", "manage_bans", "view_audit", "manage_places", "manage_invites", "manage_comments", "manage_announcements", "manage_feedback"],
    KOMACHI: ["manage_users_general", "view_audit", "manage_places", "manage_comments", "manage_feedback"]
};

function getPermissionsForLevel(adminLevel) {
    if (!adminLevel) return [];
    return PERMISSIONS[adminLevel] || [];
}

function hasPermission(user, permission) {
    if (!user || !permission) return false;
    return getPermissionsForLevel(user.admin_level).includes(permission);
}

module.exports = {
    PERMISSIONS,
    getPermissionsForLevel,
    hasPermission
};
