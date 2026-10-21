package cc.dinnerparty.foodmap;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 应用内插件需在桥接创建前注册
        registerPlugin(AMapLocationPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
