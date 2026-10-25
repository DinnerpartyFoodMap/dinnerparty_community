// 观看者与另一位住民的关系，随住民的地点列表（GET /users/:id/places）返回。
// 为以后的“屏蔽某人”预留的接缝：上线时在这里读屏蔽表，blocked 为真时前端改显示“已屏蔽 / 取消屏蔽”，
// 附近、搜索等地点列表再按同一张表排除被屏蔽者创建的地点。目前还没有屏蔽数据，blocked 恒为 false。
function viewerRelation(viewer, userId) {
    const self = !!viewer && String(viewer.id) === String(userId);
    return { self, blocked: false };
}

module.exports = { viewerRelation };
