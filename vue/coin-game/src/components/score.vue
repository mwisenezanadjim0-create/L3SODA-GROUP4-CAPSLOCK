<template>


<div>

<h2>L3 SOD GAME tactics</h2>


<button@click="getgame">#

LOAD GAME
</button>
<p>{{game}}</p> 

    
</div>
</template>
<script>

export default{
    data(){
        return{
            game:""
        }
    },

    methods:{
        async getgame()
    }
}