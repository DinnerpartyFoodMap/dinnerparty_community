// Compare the entry's home position with the actual rendered notice, in viewport coordinates.
export function getExhibitionTop(homeRect, noticeRect, parentTop = 0) {
    const overlaps = noticeRect && homeRect.right > noticeRect.left && homeRect.left < noticeRect.right
        && homeRect.bottom > noticeRect.top && homeRect.top < noticeRect.bottom;
    return Math.ceil((overlaps ? noticeRect.bottom + 8 : homeRect.top) - parentTop);
}
