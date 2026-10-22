import React, { useMemo, useState } from "react";
import Button from "../components/primitives/Button";
import AdminPlaces from "./AdminPlaces";
import AdminUsers from "./AdminUsers";
import AdminComments from "./AdminComments";
import AdminGeneralUsers from "./AdminGeneralUsers";
import AdminQQWhitelist from "./AdminQQWhitelist";
import AdminAuditModal from "./AdminAuditModal";
import AdminNotices from "./AdminNotices";
import AdminExhibitions from "./AdminExhibitions";
import AdminSkinCodes from "./AdminSkinCodes";
import ScrollableView from "../components/layout/ScrollableView";
import { t } from "../i18n/index.js";

const PERMISSIONS = {
    YUYUKO: ["用户管理", "操作日志", "标记点管理", "评论管理", "QQ白名单管理", "公告发布", "皮肤兑换码"],
    YOUMU: ["普通用户管理", "操作日志", "标记点管理", "评论管理", "QQ白名单管理", "公告发布"],
    KOMACHI: ["普通用户管理", "操作日志", "标记点管理", "评论管理"]
};

export default function AdminDashboard({ user, token, backendUrl, onBackHome, onLogout, onRequireAuth }) {
    const level = user && user.admin_level ? user.admin_level : null;
    const perms = level ? (PERMISSIONS[level] || []) : [];
    const [auditOpen, setAuditOpen] = useState(false);

    const canManagePlaces = useMemo(() => perms.includes("标记点管理"), [perms]);
    const canManageUsers = useMemo(() => perms.includes("用户管理"), [perms]);
    const canManageComments = useMemo(() => perms.includes("评论管理"), [perms]);
    const canManageGeneralUsers = useMemo(() => perms.includes("普通用户管理"), [perms]);
    const canManageQQWhitelist = useMemo(() => perms.includes("QQ白名单管理"), [perms]);
    const canManageAnnouncements = useMemo(() => perms.includes("公告发布"), [perms]);
    const canViewAudit = useMemo(() => perms.includes("操作日志"), [perms]);
    // 后端独立权限 manage_skin_codes，仅 YUYUKO。
    const canManageSkinCodes = useMemo(() => perms.includes("皮肤兑换码"), [perms]);

    const rootStyle = { height: "100%", minHeight: 0, background: 'var(--color-bg-base)', padding: 20, boxSizing: "border-box", color: 'var(--color-text-primary)' };
    const containerStyle = { maxWidth: 960, margin: "0 auto" };
    const headerRow = { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 };
    const cardStyle = { background: 'var(--color-bg-surface)', borderRadius: 'var(--radius-md)', padding: 16, border: '1px solid var(--color-border)', boxShadow: '0 8px 24px var(--color-glow)' };
    const panelStyle = { marginTop: 18, background: 'var(--color-bg-surface)', padding: 12, borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' };

    return (
        <ScrollableView as="main" style={rootStyle}>
            <div style={containerStyle}>
                <div className="fm-legacy-page-heading" style={{ ...headerRow, marginTop: 50 }}>
                    <h2 style={{ margin: 0 }}>{t('admin:dashboard.title')}</h2>
                </div>

                <div className="fm-page-card" style={cardStyle}>
                    <div style={{ marginBottom: 8 }}><strong>{t('admin:dashboard.currentUser')}</strong>{user ? user.username : "-"}</div>
                    <div style={{ marginBottom: 10 }}><strong>{t('admin:dashboard.adminLevel')}</strong>{level || t('admin:dashboard.regularUser')}</div>

                    {level ? (
                        <div>
                            <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                {canViewAudit && (
                                    <Button themeAware onClick={() => setAuditOpen(true)}>{t('admin:dashboard.viewAudit')}</Button>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div style={{ color: 'var(--color-danger)' }}>{t('admin:dashboard.notAdmin')}</div>
                    )}
                </div>

                {/* 用户管理面板 */}
                {canManageUsers && (
                    <div style={panelStyle}>
                        <AdminUsers backendUrl={backendUrl} token={token} user={user} onRequireAuth={onRequireAuth} />
                    </div>
                )}

                {/* 普通用户管理面板 */}
                {canManageGeneralUsers && (
                    <div style={panelStyle}>
                        <AdminGeneralUsers backendUrl={backendUrl} token={token} user={user} onRequireAuth={onRequireAuth} />
                    </div>
                )}

                {/* 标记点管理面板 */}
                {canManagePlaces && (
                    <div style={panelStyle}>
                        <AdminPlaces backendUrl={backendUrl} token={token} user={user} onRequireAuth={onRequireAuth} />
                    </div>
                )}

                {/* QQ白名单管理面板 */}
                {canManageQQWhitelist && (
                    <div style={panelStyle}>
                        <AdminQQWhitelist backendUrl={backendUrl} token={token} user={user} onRequireAuth={onRequireAuth} />
                    </div>
                )}

                {/* 公告发布面板 */}
                {canManageAnnouncements && (
                    <div style={panelStyle}>
                        <AdminNotices backendUrl={backendUrl} token={token} user={user} onRequireAuth={onRequireAuth} />
                    </div>
                )}

                {canManageAnnouncements && (
                    <div style={panelStyle}>
                        <AdminExhibitions backendUrl={backendUrl} />
                    </div>
                )}

                {canManageSkinCodes && (
                    <div style={panelStyle}>
                        <AdminSkinCodes backendUrl={backendUrl} />
                    </div>
                )}

                {/* 评论管理面板（评论功能暂不开放） */}
                {/*canManageComments && (
                    <div style={panelStyle}>
                        <AdminComments backendUrl={backendUrl} token={token} user={user} onRequireAuth={onRequireAuth} />
                    </div>
                )*/}
            </div>
            <AdminAuditModal open={auditOpen} onClose={() => setAuditOpen(false)} backendUrl={backendUrl} token={token} />
        </ScrollableView>
    );
}
