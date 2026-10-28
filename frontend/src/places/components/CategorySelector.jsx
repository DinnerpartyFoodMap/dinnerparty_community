import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import ScrollableView from "../../components/layout/ScrollableView";
import { getPreset } from "../../motion/presets";
import { useMotionFlags } from "../../motion/MotionProvider";
import { useConfirm } from "../../components/feedback/Confirm";
import { useTips } from "../../components/feedback/Tips";
import { useAuth } from "../../auth/AuthContext";
import useDarkMode from "../../theme/useDarkMode";
import { getThemeColor, pickContrastTextColor } from "../../theme/theme";
import "../../components/forms/field.css";
import {
    createCategory as createCategoryRecord,
    fetchCategories
} from "../../api/client";
import { t } from "../../i18n/index.js";

function parseCategories(value) {
    return String(value || '')
        .split(/[,，]/)
        .map(item => item.trim())
        .filter(Boolean)
        .filter((item, index, items) => items.indexOf(item) === index);
}

function serializeCategories(categories) {
    return categories.join(', ');
}

function getCategoryLength(value) {
    return Array.from(value).reduce((length, character) => (
        length + (character.codePointAt(0) > 0x7f ? 2 : 1)
    ), 0);
}

function normalizeMatchValue(value) {
    return String(value || '')
        .normalize('NFKC')
        .toLocaleLowerCase()
        .replace(/[\s·•_\-—()（）/\\]+/g, '');
}

function getEditDistance(leftValue, rightValue) {
    const left = Array.from(leftValue);
    const right = Array.from(rightValue);
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
        const current = [leftIndex];
        for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
            const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
            current[rightIndex] = Math.min(
                current[rightIndex - 1] + 1,
                previous[rightIndex] + 1,
                previous[rightIndex - 1] + substitutionCost
            );
        }
        previous = current;
    }
    return previous[right.length];
}

function isSubsequence(needle, haystack) {
    let index = 0;
    for (const character of haystack) {
        if (character === needle[index]) index += 1;
        if (index === needle.length) return true;
    }
    return false;
}

function getMatchScore(option, rawQuery) {
    const candidate = normalizeMatchValue(option);
    const query = normalizeMatchValue(rawQuery);
    if (!candidate || !query) return Number.POSITIVE_INFINITY;
    if (candidate === query) return 0;
    if (candidate.startsWith(query)) return 1;
    if (candidate.includes(query)) return 2;
    const minimumLength = Math.min(Array.from(candidate).length, Array.from(query).length);
    if (minimumLength >= 2 && query.includes(candidate)) return 2.5;
    if (isSubsequence(query, candidate)) return 3;
    if (minimumLength >= 2 && isSubsequence(candidate, query)) return 3.5;
    if (Math.max(Array.from(candidate).length, Array.from(query).length) >= 2 && getEditDistance(candidate, query) <= 1) return 4;
    return Number.POSITIVE_INFINITY;
}

function tagStyle(dark, themeColor, selected) {
    const background = selected ? themeColor : 'var(--color-bg-overlay)';
    return {
        display: 'inline-flex',
        alignItems: 'center',
        height: 28,
        padding: '0 10px',
        borderRadius: 'var(--radius-md)',
        border: `1px solid ${selected ? themeColor : 'var(--color-border)'}`,
        background,
        color: selected ? pickContrastTextColor(background) : 'var(--color-text-primary)',
        fontSize: 12,
        lineHeight: '28px',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        flex: '0 0 auto'
    };
}

function normalizeCategoryRecord(category) {
    return {
        ...category,
        id: category?.id == null ? null : Number(category.id),
        name: String(category?.name || '').trim(),
        is_common: !!category?.is_common
    };
}

export default function CategorySelector({ backendUrl, token, value, onChange, placeholder = t('map:category.placeholder') }) {
    const dark = useDarkMode();
    const confirm = useConfirm();
    const showTip = useTips();
    const { token: contextToken } = useAuth();
    const authToken = token || contextToken;
    const rootRef = useRef(null);
    const inputRef = useRef(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [open, setOpen] = useState(false);
    const motionFlags = useMotionFlags();
    const [categories, setCategories] = useState([]);
    const [loading, setLoading] = useState(false);
    const [categoryError, setCategoryError] = useState('');
    const [creating, setCreating] = useState(false);
    const themeColor = getThemeColor() || '#E2789F';
    const selectedCategories = useMemo(() => parseCategories(value), [value]);
    const normalizedQuery = searchQuery.trim();

    useEffect(() => {
        if (!backendUrl) return undefined;
        let cancelled = false;
        setLoading(true);
        setCategoryError('');
        fetchCategories(backendUrl)
            .then((items) => {
                if (cancelled) return;
                setCategories(items.map(normalizeCategoryRecord).filter(item => item.id && item.name));
            })
            .catch((error) => {
                if (cancelled) return;
                setCategoryError(error?.message || t('map:category.loadFailed'));
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => { cancelled = true; };
    }, [backendUrl]);

    const availableCategories = useMemo(() => {
        const byName = new Map(categories.map(category => [category.name, category]));
        selectedCategories.forEach((name) => {
            if (!byName.has(name)) {
                byName.set(name, { id: null, name, is_common: false, created_by: null });
            }
        });
        return [...byName.values()];
    }, [categories, selectedCategories]);

    const displayedCategories = useMemo(() => {
        if (!normalizedQuery) {
            return availableCategories
                .filter(category => category.is_common)
                .sort((left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0));
        }
        return availableCategories
            .map(category => ({ category, score: getMatchScore(category.name, normalizedQuery) }))
            .filter(item => Number.isFinite(item.score))
            .sort((left, right) => left.score - right.score || left.category.name.localeCompare(right.category.name, 'zh-CN'))
            .map(item => item.category);
    }, [availableCategories, normalizedQuery]);

    useEffect(() => {
        const handleOutsideClick = (event) => {
            if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
        };
        document.addEventListener('mousedown', handleOutsideClick);
        return () => document.removeEventListener('mousedown', handleOutsideClick);
    }, []);

    const updateCategories = (nextCategories) => {
        if (typeof onChange === 'function') onChange(serializeCategories(nextCategories));
    };

    const removeSelectedCategory = async (category) => {
        if (!confirm || !(await confirm(t('map:category.confirmDeselect', { category })))) return;
        updateCategories(selectedCategories.filter(item => item !== category));
    };

    const selectCategory = (category) => {
        if (selectedCategories.includes(category.name)) {
            removeSelectedCategory(category.name);
            return;
        }
        updateCategories([...selectedCategories, category.name]);
        setSearchQuery('');
    };

    const upsertCategory = (category) => {
        const normalized = normalizeCategoryRecord(category);
        setCategories((items) => {
            const index = items.findIndex(item => item.id === normalized.id || item.name === normalized.name);
            if (index < 0) return [...items, normalized];
            const next = [...items];
            next[index] = normalized;
            return next;
        });
        return normalized;
    };

    const createCategory = async () => {
        const categoryName = normalizedQuery.replace(/\s+/g, ' ');
        if (!categoryName || creating) return;
        if (/[,，]/.test(categoryName)) {
            showTip && showTip(t('map:category.noComma'));
            return;
        }
        if (getCategoryLength(categoryName) > 16) {
            showTip && showTip(t('map:category.tooLong'));
            return;
        }
        if (selectedCategories.includes(categoryName)) {
            showTip && showTip(t('map:category.alreadySelected'));
            return;
        }
        if (!authToken) {
            showTip && showTip(t('map:category.loginRequired'));
            return;
        }

        setCreating(true);
        try {
            let categoryResponse;
            try {
                categoryResponse = await createCategoryRecord(backendUrl, authToken, categoryName);
            } catch (error) {
                if (error?.status !== 409 || !error.similarCategories?.length) throw error;
                const similarNames = error.similarCategories.map(category => category.name).filter(Boolean);
                const shouldCreate = confirm && await confirm(
                    t('map:category.confirmSimilar', { similarNames: similarNames.join(t('map:category.similarSeparator')), categoryName })
                );
                if (!shouldCreate) {
                    showTip && showTip(t('map:category.createCancelled'));
                    return;
                }
                categoryResponse = await createCategoryRecord(
                    backendUrl,
                    authToken,
                    categoryName,
                    { allowSimilar: true }
                );
            }

            const savedCategory = upsertCategory(categoryResponse);
            updateCategories([...selectedCategories, savedCategory.name]);
            setSearchQuery('');
            setOpen(true);
            window.setTimeout(() => inputRef.current?.focus(), 0);
        } catch (error) {
            showTip && showTip(error?.message || t('map:category.createFailed'));
        } finally {
            setCreating(false);
        }
    };

    const handleKeyDown = (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            createCategory();
        } else if (event.key === 'Escape' && open) {
            // 只收起分类下拉，不连带关闭所在的表单浮层
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            inputRef.current?.blur();
        }
    };

    const dropdownPreset = getPreset('dropdown', motionFlags);

    return (
        <div ref={rootRef} style={{ position: 'relative' }}>
            {/* 外框与输入框一致（field.css）：平时中性边框，里面的输入框聚焦时主题色；整块都能点进输入 */}
            <div
                role="group"
                aria-label={t('map:category.ariaLabel')}
                className="fm-field fm-field--group"
                onClick={() => {
                    setOpen(true);
                    inputRef.current?.focus();
                }}
                style={{
                    width: '100%',
                    minHeight: 44,
                    padding: '4px 10px',
                    boxSizing: 'border-box',
                    display: 'flex',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 6,
                    borderRadius: 22,
                    cursor: 'text'
                }}
            >
                {selectedCategories.map(category => (
                    <button
                        key={category}
                        type="button"
                        aria-pressed="true"
                        title={t('map:category.deselect', { category })}
                        onClick={(event) => {
                            event.stopPropagation();
                            removeSelectedCategory(category);
                        }}
                        style={tagStyle(dark, themeColor, true)}
                    >
                        {category}
                    </button>
                ))}
                <input
                    ref={inputRef}
                    type="search"
                    value={searchQuery}
                    maxLength={16}
                    placeholder={placeholder}
                    aria-label={t('map:category.inputAriaLabel')}
                    disabled={creating}
                    onFocus={() => setOpen(true)}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    onKeyDown={handleKeyDown}
                    style={{
                        flex: '1 1 100px',
                        minWidth: 100,
                        height: 34,
                        padding: 0,
                        border: 0,
                        outline: 'none',
                        background: 'transparent',
                        color: 'var(--color-text-primary)',
                        fontSize: 14
                    }}
                />
            </div>

            <AnimatePresence>
            {open && (
                <motion.div
                    key="category-dropdown"
                    initial={dropdownPreset.initial}
                    animate={dropdownPreset.animate}
                    exit={dropdownPreset.exit}
                    style={{
                    position: 'absolute',
                    top: 'calc(100% + 5px)',
                    left: 0,
                    width: '100%',
                    zIndex: 20,
                    overflow: 'hidden',
                    border: '1px solid var(--color-border)',
                    borderRadius: 8,
                    background: 'var(--color-bg-surface)',
                    boxShadow: 'var(--shadow-surface)'
                }}>
                    <ScrollableView style={{ maxHeight: 220, padding: 10 }}>
                        <div style={{ marginBottom: 8, color: 'var(--color-text-secondary)', fontSize: 12, fontWeight: 600 }}>
                            {normalizedQuery ? t('map:category.matching') : t('map:category.frequent')}
                        </div>

                        {loading && <div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>{t('map:category.loading')}</div>}
                        {!loading && categoryError && <div style={{ color: 'var(--color-danger)', fontSize: 12 }}>{categoryError}</div>}

                        {!loading && !categoryError && displayedCategories.length > 0 && (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                {displayedCategories.map(category => {
                                    const selected = selectedCategories.includes(category.name);
                                    return (
                                        <button
                                            key={category.id || category.name}
                                            type="button"
                                            aria-pressed={selected}
                                            onClick={() => selectCategory(category)}
                                            style={tagStyle(dark, themeColor, selected)}
                                        >
                                            {category.name}
                                        </button>
                                    );
                                })}
                            </div>
                        )}

                        {!loading && !categoryError && !normalizedQuery && displayedCategories.length === 0 && (
                            <div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>{t('map:category.noFrequent')}</div>
                        )}

                        {!loading && !categoryError && !!normalizedQuery && (
                            <div style={{
                                marginTop: displayedCategories.length ? 10 : 0,
                                paddingTop: displayedCategories.length ? 9 : 0,
                                borderTop: displayedCategories.length ? '1px solid var(--color-border)' : 'none',
                                color: 'var(--color-text-secondary)',
                                fontSize: 12,
                                lineHeight: 1.5
                            }}>
                                {displayedCategories.length
                                    ? t('map:category.enterToCreate')
                                    : t('map:category.noMatchEnterToCreate')}
                            </div>
                        )}
                    </ScrollableView>
                </motion.div>
            )}
            </AnimatePresence>
        </div>
    );
}
