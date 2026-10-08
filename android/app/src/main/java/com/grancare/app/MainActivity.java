package com.grancare.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GranCareNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
