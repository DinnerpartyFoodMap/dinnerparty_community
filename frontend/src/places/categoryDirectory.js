// 分类目录（GET /categories）整个页面只读一次：地图筛选、地点列表与 iOS 原生地点表单共用。读取失败时下次重新请求。
import { fetchCategories } from '../api/client';

let categoriesPromise = null;

export function loadCategoryDirectory(backendUrl) {
    if (!categoriesPromise) {
        categoriesPromise = fetchCategories(backendUrl)
            .then((list) => list.filter((item) => item && item.name))
            .catch((error) => {
                categoriesPromise = null;
                throw error;
            });
    }
    return categoriesPromise;
}

/** 添加地点后目录可能多了新分类：下次读取时重新请求 */
export function invalidateCategoryDirectory() {
    categoriesPromise = null;
}
