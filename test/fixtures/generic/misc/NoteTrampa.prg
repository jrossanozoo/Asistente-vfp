define class Trampa as Custom

	*-----------------------------------------------------------------------------------------
	NOTE	[Gotcha] Este NOTE se come la función siguiente. ;
			Retorna: Void - nada. ;
	function Desaparece() as Void
	endfunc

	*-----------------------------------------------------------------------------------------
	NOTE	[Contrato] Este NOTE queda huérfano porque lo sigue código.
	nCantidad = 0
	lcNombre = "ñandú"

	*-----------------------------------------------------------------------------------------
	* Comentario clásico de respaldo.
	* Segunda línea.
	function ConComentario( tnA, tnB )
		NOTE	Este NOTE esta dentro del cuerpo.
		return tnA + tnB
	endfunc

	procedure ConLparameters
		* comentario previo
		lparameters tcUno as String, tnDos as Integer
		local loX as Custom
		loX = createobject( "Trampa" )
		text to lcTexto noshow
			function NoEsUnaFuncion()
		endtext
	endproc

enddefine

*-----------------------------------------------------------------------------------------
NOTE	[Obsoleto] Suma dos números. ;
		Parametros: ;
			tnA - Primer sumando. ;
			tnB - Segundo sumando ;
				que sigue en otra línea. ;
		Retorna: Number - la suma. ;
		Ejemplo: ;
			? Sumar( 1, 2 )
function Sumar( tnA as Number, tnB as Number ) as Number
	return tnA + tnB
endfunc

function Llamadas
	local lcX
	lcX = Sumar( 1, Sumar( 2, 3 ), ;
		4 )
	lcX = Foo( "x,y", [a,b], laArr[1, 2] )
endfunc
