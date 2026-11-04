import React from 'react';
import {createRoot} from 'react-dom/client';
import {MotionProvider} from '../../src/motion/MotionProvider';
import {OverlayHost} from '../../src/components/overlay/OverlayHost';
import PlaceRatingPanel from '../../src/places/components/PlaceRatingPanel';
import usePlaceRating from '../../src/places/hooks/usePlaceRating';
import {ratingPlaceForViewer} from '../../src/places/rating';
import '../../src/styles/tokens.css';
window.__TEST_TIPS=[];
function Harness(){
    const rating=usePlaceRating({backendUrl:location.origin,token:window.__TEST_TOKEN,placeId:1});
    const place=ratingPlaceForViewer({id:1,name:'评分回归地点',...(window.__TEST_PRELOADED?{rating_count:2,rating_average:3.2,rating_viewer_id:'viewer',predicted_rating:{active:true,status:'ready',average:3.6,ranking_score:3.9}}:{})},'viewer');
    return <><output id="rating-state">{JSON.stringify(rating.data)}</output><PlaceRatingPanel open place={place} rating={rating} isAuthenticated onClose={()=>{}} showTip={tip=>window.__TEST_TIPS.push(tip)}/></>;
}
createRoot(document.getElementById('root')).render(<MotionProvider><OverlayHost><Harness/></OverlayHost></MotionProvider>);
