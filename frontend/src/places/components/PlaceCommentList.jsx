import React from 'react';
import { commentLine, commentStatusNote } from '../placeComments';

/**
 * 接在地点描述后面的住民评论：每条一行「住民名：评论」，自己那条未公开时后面跟一句小字。
 * 列表最后是“写评论 / 修改我的评论”（onWrite 为空时不显示，例如高德临时地点、封禁账号）。
 */
export default function PlaceCommentList({ comments, onWrite, writeLabel, style }) {
    const list = Array.isArray(comments) ? comments : [];
    if (!list.length && !onWrite) return null;
    return (
        <div style={{ marginTop: 8, ...style }}>
            {list.map((comment) => {
                const note = commentStatusNote(comment);
                return (
                    <div key={comment.id} style={{ lineHeight: 1.55, overflowWrap: 'anywhere', color: 'var(--color-text-primary)' }}>
                        {commentLine(comment)}
                        {note && <span style={{ marginLeft: 6, fontSize: 12, color: 'var(--color-text-muted)' }}>{note}</span>}
                    </div>
                );
            })}
            {onWrite && (
                <button
                    type="button"
                    onClick={onWrite}
                    className="fm-pressable"
                    style={{ marginTop: list.length ? 4 : 0, padding: '2px 0', border: 0, background: 'transparent', font: 'inherit', fontSize: 13, color: 'var(--theme-primary)', cursor: 'pointer' }}
                >
                    {writeLabel}
                </button>
            )}
        </div>
    );
}
